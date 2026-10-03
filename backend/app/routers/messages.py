from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import MensajeRed, Dispositivo

router = APIRouter(prefix="/messages", tags=["messages"])


class MensajeCreate(BaseModel):
    titulo: str
    contenido: str
    tipo: str = "info"  # "info", "aviso", "urgente"
    alcance: str = "todos"  # "todos", "nivel_1", "nivel_2", "dispositivo"
    dispositivo_id: int | None = None
    direccion_ip: str | None = None


@router.get("/")
def list_messages(db: Session = Depends(get_db)):
    """Lista todos los mensajes y anuncios emitidos desde la consola."""
    return db.query(MensajeRed).order_by(MensajeRed.creado_en.desc()).limit(50).all()


@router.post("/")
def send_message(data: MensajeCreate, db: Session = Depends(get_db)):
    """Emite un nuevo mensaje o anuncio hacia las estaciones de trabajo."""
    if not data.titulo.strip() or not data.contenido.strip():
        raise HTTPException(status_code=400, detail="Título y contenido del mensaje son obligatorios")

    target_ip = data.direccion_ip
    if data.dispositivo_id and not target_ip:
        dev = db.query(Dispositivo).filter(Dispositivo.id == data.dispositivo_id).first()
        if dev:
            target_ip = dev.direccion_ip

    nuevo = MensajeRed(
        titulo=data.titulo.strip(),
        contenido=data.contenido.strip(),
        tipo=data.tipo or "info",
        alcance=data.alcance or "todos",
        dispositivo_id=data.dispositivo_id,
        direccion_ip=target_ip,
        creado_en=datetime.now(),
        activo=True,
        creado_por="Administrador",
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    return {"ok": True, "mensaje": nuevo}


@router.get("/active")
def get_active_messages(request: Request, ip: str | None = None, rol: str | None = None, db: Session = Depends(get_db)):
    """Obtiene los anuncios vigentes dirigidos a una estación específica (usado por portal.html)."""
    client_ip = ip
    if not client_ip:
        forwarded = request.headers.get("x-forwarded-for")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "127.0.0.1")

    # Detectar rol si no se proveyó
    if not rol:
        dev = db.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()
        rol = (getattr(dev, "rol", "nivel_1") or "nivel_1") if dev else "nivel_1"

    # Buscar mensajes activos que apliquen a todos, o a su rol, o a su IP
    mensajes = (
        db.query(MensajeRed)
        .filter(MensajeRed.activo == True)
        .order_by(MensajeRed.creado_en.desc())
        .limit(10)
        .all()
    )

    aplicables = []
    for m in mensajes:
        if m.alcance == "todos":
            aplicables.append(m)
        elif m.alcance == rol:
            aplicables.append(m)
        elif m.alcance == "dispositivo" and (m.direccion_ip == client_ip or client_ip in ("127.0.0.1", "localhost")):
            aplicables.append(m)

    return aplicables


@router.delete("/{message_id}")
def dismiss_message(message_id: int, db: Session = Depends(get_db)):
    """Desactiva o retira un mensaje de la red."""
    msg = db.query(MensajeRed).filter(MensajeRed.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")

    msg.activo = False
    db.commit()
    return {"ok": True, "mensaje": "Mensaje desactivado"}
