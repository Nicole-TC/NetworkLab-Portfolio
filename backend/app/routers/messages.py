from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import MensajeRed, MensajeLectura, Dispositivo, Sesion

router = APIRouter(prefix="/messages", tags=["messages"])


class MensajeCreate(BaseModel):
    titulo: str
    contenido: str
    tipo: str = "info"  # "info", "aviso", "urgente"
    alcance: str = "todos"  # "todos", "nivel_1", "nivel_2", "dispositivo"
    dispositivo_id: int | None = None
    direccion_ip: str | None = None


class MarcarLeidoRequest(BaseModel):
    ip: str | None = None
    mac: str | None = None
    nombre: str | None = None


@router.get("/")
def list_messages(db: Session = Depends(get_db)):
    """Lista todos los mensajes y anuncios emitidos desde la consola, incluyendo confirmaciones de lectura x/y según destinatarios."""
    mensajes = db.query(MensajeRed).order_by(MensajeRed.creado_en.desc()).limit(50).all()

    # Contar equipos de alumnos actualmente conectados con sesión activa (excluyendo la consola admin)
    sesiones_activas = (
        db.query(Sesion)
        .join(Dispositivo, Sesion.dispositivo_id == Dispositivo.id)
        .filter(Sesion.fin.is_(None))
        .filter(Dispositivo.rol != "admin")
        .all()
    )
    total_alumnos_conectados = len(sesiones_activas)
    if total_alumnos_conectados <= 0:
        total_alumnos_conectados = db.query(Dispositivo).filter(Dispositivo.estado == "aprobado", Dispositivo.rol != "admin").count()
    if total_alumnos_conectados <= 0:
        total_alumnos_conectados = 1

    # Desglose de dispositivos conectados por rol
    roles_conectados = {}
    for s in sesiones_activas:
        r = getattr(s.dispositivo, "rol", "nivel_1") or "nivel_1"
        roles_conectados[r] = roles_conectados.get(r, 0) + 1

    resultado = []
    for m in mensajes:
        total_leidos = db.query(MensajeLectura).filter(MensajeLectura.mensaje_id == m.id).count()

        # Determinar la cantidad real de destinatarios según el alcance del comunicado
        if m.alcance == "dispositivo":
            total_destinatarios = 1
        elif m.alcance in ("nivel_1", "nivel_2"):
            total_destinatarios = roles_conectados.get(m.alcance, 0)
            if total_destinatarios <= 0:
                total_destinatarios = db.query(Dispositivo).filter(Dispositivo.rol == m.alcance, Dispositivo.estado == "aprobado").count()
            if total_destinatarios <= 0:
                total_destinatarios = 1
        else:
            # "todos"
            total_destinatarios = total_alumnos_conectados

        resultado.append({
            "id": m.id,
            "titulo": m.titulo,
            "contenido": m.contenido,
            "tipo": m.tipo,
            "alcance": m.alcance,
            "dispositivo_id": m.dispositivo_id,
            "direccion_ip": m.direccion_ip,
            "creado_en": m.creado_en.isoformat() if m.creado_en else None,
            "activo": m.activo,
            "creado_por": m.creado_por,
            "total_leidos": total_leidos,
            "total_conectados": total_destinatarios,
        })
    return resultado


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

    # Buscar mensajes activos
    mensajes = (
        db.query(MensajeRed)
        .filter(MensajeRed.activo == True)
        .order_by(MensajeRed.creado_en.desc())
        .limit(10)
        .all()
    )

    # Identificar mensajes que este dispositivo ya confirmó como leídos
    leidos_ids = set(
        r[0] for r in db.query(MensajeLectura.mensaje_id)
        .filter(MensajeLectura.direccion_ip == client_ip)
        .all()
    )

    aplicables = []
    for m in mensajes:
        # Si ya lo leyó, no se lo volvemos a mostrar
        if m.id in leidos_ids:
            continue

        if m.alcance == "todos":
            aplicables.append(m)
        elif m.alcance == rol:
            aplicables.append(m)
        elif m.alcance == "dispositivo" and (m.direccion_ip == client_ip or client_ip in ("127.0.0.1", "localhost")):
            aplicables.append(m)

    return aplicables


@router.post("/{message_id}/read")
def mark_message_as_read(message_id: int, request: Request, data: MarcarLeidoRequest | None = None, db: Session = Depends(get_db)):
    """Registra la confirmación de lectura de un mensaje por parte de un dispositivo."""
    msg = db.query(MensajeRed).filter(MensajeRed.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")

    client_ip = data.ip if (data and data.ip) else None
    if not client_ip:
        forwarded = request.headers.get("x-forwarded-for")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "127.0.0.1")

    client_mac = data.mac if data else None
    nombre = data.nombre if data else None

    # Evitar duplicados por mensaje e IP
    existe = (
        db.query(MensajeLectura)
        .filter(MensajeLectura.mensaje_id == message_id)
        .filter(MensajeLectura.direccion_ip == client_ip)
        .first()
    )

    if not existe:
        nueva_lectura = MensajeLectura(
            mensaje_id=message_id,
            direccion_ip=client_ip,
            direccion_mac=client_mac,
            nombre_dispositivo=nombre,
            leido_en=datetime.now(),
        )
        db.add(nueva_lectura)
        db.commit()

    return {"ok": True, "mensaje_id": message_id, "leido": True}


@router.delete("/{message_id}")
def dismiss_message(message_id: int, db: Session = Depends(get_db)):
    """Desactiva o retira un mensaje de la red."""
    msg = db.query(MensajeRed).filter(MensajeRed.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")

    msg.activo = False
    db.commit()
    return {"ok": True, "mensaje": "Mensaje desactivado"}

