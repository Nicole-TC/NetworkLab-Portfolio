from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import DominioBloqueado
from app import routeros_client

router = APIRouter(prefix="/filter", tags=["web_filter"])


class DominioCreate(BaseModel):
    dominio: str | None = None
    domain: str | None = None
    categoria: str | None = "General"
    category: str | None = None


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
    """Lista todos los dominios bloqueados en la base de datos."""
    return db.query(DominioBloqueado).order_by(DominioBloqueado.fecha_creacion.desc()).all()


@router.post("/domains")
def block_domain(data: DominioCreate, db: Session = Depends(get_db)):
    """Agrega un dominio a la lista negra y lo bloquea en MikroTik via DNS estático."""
    raw_domain = data.dominio or data.domain or ""
    dominio = limpiar_dominio(raw_domain)
    categoria = data.categoria or data.category or "General"

    if not dominio or "." not in dominio:
        raise HTTPException(status_code=400, detail="Formato de dominio inválido (ej: youtube.com)")

    existente = db.query(DominioBloqueado).filter(DominioBloqueado.dominio == dominio).first()
    if existente:
        # Asegurar que esté activo en MikroTik
        routeros_client.add_dns_block(dominio)
        return {"ok": True, "dominio": existente, "mensaje": "El dominio ya estaba en la lista, se aseguró el bloqueo en MikroTik"}

    nuevo = DominioBloqueado(
        dominio=dominio,
        categoria=categoria,
        fecha_creacion=datetime.now(),
        esta_activo=True,
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    routeros_client.add_dns_block(dominio)

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

