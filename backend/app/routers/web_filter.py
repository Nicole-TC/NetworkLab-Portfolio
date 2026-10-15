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
    alcance: str | None = "todos"  # "todos", "todos_excepto", "solo_seleccionados", "rol_nivel_1", "rol_nivel_2"
    dispositivos_ids: list[int] | None = []


class DominioUpdate(BaseModel):
    dominio: str | None = None
    categoria: str | None = None
    alcance: str | None = None
    dispositivos_ids: list[int] | None = None
    esta_activo: bool | None = None


def limpiar_dominio(url_o_dominio: str) -> str:
    """Extrae el dominio limpio quitando http://, https://, www., parámetros y barras."""
    d = url_o_dominio.strip().lower()
    for prefix in ["https://", "http://", "www."]:
        if d.startswith(prefix):
            d = d[len(prefix):]
    d = d.split("/")[0].split("?")[0].strip()

    # Normalizar nombres directos y errores tipográficos comunes
    if d in ("youtube", "yotube", "yt"):
        d = "youtube.com"
    elif d in ("yotube.com", "youtub.com"):
        d = "youtube.com"
    elif d in ("wikipedia", "wiki"):
        d = "wikipedia.org"
    elif d in ("google", "goog"):
        d = "google.com"
    elif d in ("github", "git"):
        d = "github.com"
    elif d and "." not in d and len(d) > 1:
        d = f"{d}.com"

    return d


def asegurar_dominios_estudio_defecto(db: Session):
    """Siembra sitios de estudio básicos por defecto si la lista blanca está vacía."""
    total = db.query(DominioBloqueado).count()
    if total == 0:
        defaults = [
            ("google.com", "Buscadores"),
            ("wikipedia.org", "Educación / Estudio"),
            ("classroom.google.com", "Educación / Estudio"),
            ("github.com", "Herramientas"),
        ]
        for dom, cat in defaults:
            db.add(DominioBloqueado(
                dominio=dom,
                categoria=cat,
                alcance="todos",
                tipo="blanca",
                fecha_creacion=datetime.now(),
                esta_activo=True,
            ))
        db.commit()


def sync_all_whitelist_to_router(db: Session = None):
    """Sincroniza todos los dominios de la Lista Blanca con el firewall de MikroTik respetando alcances."""
    should_close = False
    if db is None:
        from app.database import SessionLocal
        db = SessionLocal()
        should_close = True
    try:
        dominios = db.query(DominioBloqueado).filter(DominioBloqueado.esta_activo == True).all()
        todos_devs = {d.id: d.direccion_ip for d in db.query(Dispositivo).all() if d.direccion_ip}

        domain_rules = []
        for d in dominios:
            raw_ids = [int(x.strip()) for x in (d.dispositivos_ids or "").split(",") if x.strip().isdigit()]
            target_ips = [todos_devs[dev_id] for dev_id in raw_ids if dev_id in todos_devs]
            domain_rules.append({
                "id": d.id,
                "dominio": d.dominio,
                "alcance": d.alcance or "todos",
                "target_ips": target_ips,
            })

        exempt_ips = set()
        admin_macs = settings.admin_mac_list
        for dev in db.query(Dispositivo).all():
            m_norm = (dev.direccion_mac or "").strip().upper()
            if m_norm in admin_macs or getattr(dev, "exento_filtro", False) or getattr(dev, "rol", "") == "nivel_2":
                if dev.direccion_ip:
                    exempt_ips.add(dev.direccion_ip)

        routeros_client.sync_whitelist_filter(domain_rules, exempt_ips=list(exempt_ips))
    except Exception as e:
        print("Nota sincronizando Lista Blanca con MikroTik:", e)
    finally:
        if should_close:
            db.close()


@router.get("/domains")
def list_blocked_domains(db: Session = Depends(get_db)):
    """Lista todos los dominios autorizados en la Lista Blanca."""
    asegurar_dominios_estudio_defecto(db)
    sync_all_whitelist_to_router(db)
    dominios = db.query(DominioBloqueado).order_by(DominioBloqueado.fecha_creacion.desc()).all()
    todos_devs = {d.id: (d.nombre_host or d.direccion_ip or f"PC-{d.id}") for d in db.query(Dispositivo).all()}

    resultado = []
    for d in dominios:
        raw_ids = [int(x.strip()) for x in (d.dispositivos_ids or "").split(",") if x.strip().isdigit()]
        nombres_pcs = [todos_devs.get(dev_id, f"PC-{dev_id}") for dev_id in raw_ids]
        resultado.append({
            "id": d.id,
            "dominio": d.dominio,
            "categoria": d.categoria or "Educación / Estudio",
            "alcance": d.alcance or "todos",
            "tipo": getattr(d, "tipo", "blanca") or "blanca",
            "dispositivos_ids": raw_ids,
            "nombres_pcs": nombres_pcs,
            "fecha_creacion": d.fecha_creacion,
            "esta_activo": d.esta_activo,
        })
    return resultado


@router.post("/domains")
def block_domain(data: DominioCreate, db: Session = Depends(get_db)):
    """Agrega o actualiza un dominio en la Lista Blanca y lo autoriza en MikroTik."""
    raw_domain = data.dominio or data.domain or ""
    dominio = limpiar_dominio(raw_domain)
    categoria = data.categoria or data.category or "Educación / Estudio"
    alcance = data.alcance or "todos"
    dispositivos_ids = data.dispositivos_ids or []
    dispositivos_ids_str = ",".join(str(i) for i in dispositivos_ids)

    if not dominio or "." not in dominio:
        raise HTTPException(status_code=400, detail="Formato de dominio inválido (ej: wikipedia.org, google.com)")

    existente = db.query(DominioBloqueado).filter(DominioBloqueado.dominio == dominio).first()
    if existente:
        existente.categoria = categoria
        existente.alcance = alcance
        existente.dispositivos_ids = dispositivos_ids_str
        existente.tipo = "blanca"
        existente.esta_activo = True
        db.commit()
        db.refresh(existente)
        sync_all_whitelist_to_router(db)
        return {"ok": True, "dominio": existente, "mensaje": f"Dominio {dominio} actualizado en la Lista Blanca"}

    nuevo = DominioBloqueado(
        dominio=dominio,
        categoria=categoria,
        alcance=alcance,
        dispositivos_ids=dispositivos_ids_str,
        tipo="blanca",
        fecha_creacion=datetime.now(),
        esta_activo=True,
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    sync_all_whitelist_to_router(db)

    return {"ok": True, "dominio": nuevo, "mensaje": f"Dominio {dominio} autorizado en la Lista Blanca de MikroTik"}


@router.put("/domains/{domain_id}")
def update_domain(domain_id: int, data: DominioUpdate, db: Session = Depends(get_db)):
    """Permite editar el alcance de navegación, categoría o estado de un dominio autorizado."""
    dom = db.query(DominioBloqueado).filter(DominioBloqueado.id == domain_id).first()
    if not dom:
        raise HTTPException(status_code=404, detail="Dominio no encontrado")

    if data.dominio is not None and data.dominio.strip():
        dom.dominio = limpiar_dominio(data.dominio)
    if data.categoria is not None:
        dom.categoria = data.categoria
    if data.alcance is not None:
        dom.alcance = data.alcance
    if data.dispositivos_ids is not None:
        dom.dispositivos_ids = ",".join(str(i) for i in data.dispositivos_ids)
    if data.esta_activo is not None:
        dom.esta_activo = data.esta_activo

    db.commit()
    db.refresh(dom)
    sync_all_whitelist_to_router(db)

    todos_devs = {d.id: (d.nombre_host or d.direccion_ip or f"PC-{d.id}") for d in db.query(Dispositivo).all()}
    raw_ids = [int(x.strip()) for x in (dom.dispositivos_ids or "").split(",") if x.strip().isdigit()]
    nombres_pcs = [todos_devs.get(dev_id, f"PC-{dev_id}") for dev_id in raw_ids]

    return {
        "ok": True,
        "dominio": {
            "id": dom.id,
            "dominio": dom.dominio,
            "categoria": dom.categoria,
            "alcance": dom.alcance,
            "tipo": getattr(dom, "tipo", "blanca") or "blanca",
            "dispositivos_ids": raw_ids,
            "nombres_pcs": nombres_pcs,
            "fecha_creacion": dom.fecha_creacion,
            "esta_activo": dom.esta_activo,
        },
        "mensaje": f"Dominio {dom.dominio} actualizado correctamente en la Lista Blanca",
    }


@router.delete("/domains/{domain_id}")
def unblock_domain(domain_id: int, db: Session = Depends(get_db)):
    """Revoca un dominio de la Lista Blanca y actualiza MikroTik."""
    dom = db.query(DominioBloqueado).filter(DominioBloqueado.id == domain_id).first()
    if not dom:
        raise HTTPException(status_code=404, detail="Dominio no encontrado")

    dom_nombre = dom.dominio
    db.delete(dom)
    db.commit()
    sync_all_whitelist_to_router(db)

    return {"ok": True, "dominio_id": domain_id, "desbloqueado": dom_nombre, "mensaje": f"Dominio {dom_nombre} revocado de la Lista Blanca"}


@router.get("/mikrotik-active")
def get_mikrotik_active_dns_blocks():
    """Consulta directamente los dominios autorizados en la memoria de RouterOS."""
    return {"dominios_en_mikrotik": routeros_client.get_dns_blocks()}


@router.post("/sync")
def sync_filter(db: Session = Depends(get_db)):
    """Fuerza la sincronización de la Lista Blanca completa en MikroTik."""
    sync_all_whitelist_to_router(db)
    return {"ok": True, "mensaje": "Lista Blanca sincronizada con RouterOS"}



