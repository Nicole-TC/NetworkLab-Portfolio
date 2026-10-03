from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import DominioBloqueado, Dispositivo
from app.config import settings
from app import routeros_client

router = APIRouter(prefix="/filter", tags=["web_filter"])


class DominioCreate(BaseModel):
    dominio: str | None = None
    domain: str | None = None
    categoria: str | None = "General"
    category: str | None = None
    alcance: str | None = "todos"  # "todos", "todos_excepto", "solo_seleccionados"
    dispositivos_ids: list[int] | None = []


def limpiar_dominio(url_o_dominio: str) -> str:
    """Extrae el dominio limpio quitando http://, https://, www. y barras."""
    d = url_o_dominio.strip().lower()
    for prefix in ["https://", "http://", "www."]:
        if d.startswith(prefix):
            d = d[len(prefix):]
    d = d.split("/")[0]
    return d


@router.get("/domains")
def list_blocked_domains(db: Session = Depends(get_db)):
    """Lista todos los dominios bloqueados con detalle de su alcance."""
    dominios = db.query(DominioBloqueado).order_by(DominioBloqueado.fecha_creacion.desc()).all()
    todos_devs = {d.id: (d.nombre_host or d.direccion_ip or f"PC-{d.id}") for d in db.query(Dispositivo).all()}

    resultado = []
    for d in dominios:
        raw_ids = [int(x.strip()) for x in (d.dispositivos_ids or "").split(",") if x.strip().isdigit()]
        nombres_pcs = [todos_devs.get(dev_id, f"PC-{dev_id}") for dev_id in raw_ids]
        resultado.append({
            "id": d.id,
            "dominio": d.dominio,
            "categoria": d.categoria,
            "alcance": d.alcance or "todos",
            "dispositivos_ids": raw_ids,
            "nombres_pcs": nombres_pcs,
            "fecha_creacion": d.fecha_creacion,
            "esta_activo": d.esta_activo,
        })
    return resultado


@router.post("/domains")
def block_domain(data: DominioCreate, db: Session = Depends(get_db)):
    """Agrega un dominio a la lista negra con el alcance configurado y lo bloquea en MikroTik."""
    raw_domain = data.dominio or data.domain or ""
    dominio = limpiar_dominio(raw_domain)
    categoria = data.categoria or data.category or "General"
    alcance = data.alcance or "todos"
    dispositivos_ids = data.dispositivos_ids or []
    dispositivos_ids_str = ",".join(str(i) for i in dispositivos_ids)

    if not dominio or "." not in dominio:
        raise HTTPException(status_code=400, detail="Formato de dominio inválido (ej: youtube.com)")

    # Recopilar IPs afectadas
    target_ips = []
    exempt_ips = []
    admin_macs = settings.admin_mac_list

    # Siempre incluir admin IPs en exempt_ips
    for dev in db.query(Dispositivo).all():
        m_norm = (dev.direccion_mac or "").strip().upper()
        if m_norm in admin_macs and dev.direccion_ip:
            exempt_ips.append(dev.direccion_ip)

    router_alcance = alcance
    if alcance == "rol_nivel_1":
        for dev in db.query(Dispositivo).all():
            m_norm = (dev.direccion_mac or "").strip().upper()
            if m_norm not in admin_macs and dev.direccion_ip:
                d_rol = getattr(dev, "rol", "nivel_1") or "nivel_1"
                if d_rol in ("nivel_1", "alumno"):
                    target_ips.append(dev.direccion_ip)
                else:
                    if dev.direccion_ip not in exempt_ips:
                        exempt_ips.append(dev.direccion_ip)
        router_alcance = "solo_seleccionados"
    elif alcance == "rol_nivel_2":
        for dev in db.query(Dispositivo).all():
            m_norm = (dev.direccion_mac or "").strip().upper()
            if m_norm not in admin_macs and dev.direccion_ip:
                d_rol = getattr(dev, "rol", "nivel_1") or "nivel_1"
                if d_rol == "nivel_2":
                    target_ips.append(dev.direccion_ip)
                else:
                    if dev.direccion_ip not in exempt_ips:
                        exempt_ips.append(dev.direccion_ip)
        router_alcance = "solo_seleccionados"
    elif dispositivos_ids:
        seleccionados = db.query(Dispositivo).filter(Dispositivo.id.in_(dispositivos_ids)).all()
        selected_ips = [dev.direccion_ip for dev in seleccionados if dev.direccion_ip]
        if alcance == "solo_seleccionados":
            target_ips = selected_ips
        elif alcance == "todos_excepto":
            for ip in selected_ips:
                if ip not in exempt_ips:
                    exempt_ips.append(ip)

    existente = db.query(DominioBloqueado).filter(DominioBloqueado.dominio == dominio).first()
    if existente:
        existente.categoria = categoria
        existente.alcance = alcance
        existente.dispositivos_ids = dispositivos_ids_str
        db.commit()
        db.refresh(existente)
        routeros_client.add_dns_block(dominio, alcance=router_alcance, target_ips=target_ips, exempt_ips=exempt_ips)
        return {"ok": True, "dominio": existente, "mensaje": "Regla actualizada con el nuevo alcance en MikroTik"}

    nuevo = DominioBloqueado(
        dominio=dominio,
        categoria=categoria,
        alcance=alcance,
        dispositivos_ids=dispositivos_ids_str,
        fecha_creacion=datetime.now(),
        esta_activo=True,
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    routeros_client.add_dns_block(dominio, alcance=router_alcance, target_ips=target_ips, exempt_ips=exempt_ips)

    return {"ok": True, "dominio": nuevo}


@router.delete("/domains/{domain_id}")
def unblock_domain(domain_id: int, db: Session = Depends(get_db)):
    """Elimina un dominio de la lista negra y lo desbloquea en MikroTik."""
    bloqueado = db.query(DominioBloqueado).filter(DominioBloqueado.id == domain_id).first()
    if not bloqueado:
        raise HTTPException(status_code=404, detail="Dominio no encontrado")

    routeros_client.remove_dns_block(bloqueado.dominio)

    db.delete(bloqueado)
    db.commit()

    return {"ok": True, "dominio_id": domain_id, "desbloqueado": bloqueado.dominio}


@router.get("/mikrotik-active")
def get_mikrotik_active_dns_blocks():
    """Consulta directamente los dominios bloqueados en la memoria de RouterOS."""
    return {"dominios_en_mikrotik": routeros_client.get_dns_blocks()}


