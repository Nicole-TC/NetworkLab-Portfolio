import os
import uuid
import base64
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import Dispositivo, EstadoDispositivo, ConfiguracionModulo, GrupoRed, GrupoMiembro, MensajeGrupo
from app.routers.activity import deducir_tipo_dispositivo
from app.routers.devices import check_ip_ping
from app.config import settings
from app import routeros_client

router = APIRouter(prefix="/groups", tags=["groups"])

CHAT_UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads_chat")
os.makedirs(CHAT_UPLOAD_DIR, exist_ok=True)


# --- Schemas ---
class ToggleAislamientoBody(BaseModel):
    activo: bool


class CrearEditarGrupoBody(BaseModel):
    nombre: str
    color: str = "#6366f1"
    dispositivos_ids: List[int]
    lider_dispositivo_id: Optional[int] = None
    permite_archivos_lider: bool = True
    permite_chat_admin: bool = True
    esta_activo: bool = True


class EnviarMensajeBody(BaseModel):
    canal_tipo: str  # 'grupo', 'directo', 'admin', 'red_general'
    grupo_id: Optional[int] = None
    receptor_ip: Optional[str] = None
    contenido: str
    archivo_nombre: Optional[str] = None
    archivo_base64: Optional[str] = None


# --- Helpers ---
def obtener_ip_cliente(request: Request) -> str:
    """Extrae la IP real del cliente."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "127.0.0.1"


def get_aislamiento_activo(db: Session) -> bool:
    conf = db.query(ConfiguracionModulo).filter(ConfiguracionModulo.clave == "modo_aislamiento_grupos").first()
    if not conf:
        return False
    return conf.valor.strip().lower() in ("true", "1", "si", "on")


def set_aislamiento_activo(db: Session, activo: bool):
    conf = db.query(ConfiguracionModulo).filter(ConfiguracionModulo.clave == "modo_aislamiento_grupos").first()
    val_str = "true" if activo else "false"
    if not conf:
        conf = ConfiguracionModulo(clave="modo_aislamiento_grupos", valor=val_str, actualizado_en=datetime.now())
        db.add(conf)
    else:
        conf.valor = val_str
        conf.actualizado_en = datetime.now()
    db.commit()


# --- Endpoints de Administración de Grupos ---

@router.get("/status")
def get_groups_status(db: Session = Depends(get_db)):
    """Retorna si el modo aislamiento de grupos está activo y estadísticas generales."""
    aislamiento = get_aislamiento_activo(db)
    total_grupos = db.query(GrupoRed).count()
    grupos_activos = db.query(GrupoRed).filter(GrupoRed.esta_activo.is_(True)).count()
    total_asignados = db.query(GrupoMiembro).count()
    total_dispositivos = db.query(Dispositivo).filter(Dispositivo.estado == EstadoDispositivo.aprobado).count()

    return {
        "aislamiento_activo": aislamiento,
        "total_grupos": total_grupos,
        "grupos_activos": grupos_activos,
        "dispositivos_asignados": total_asignados,
        "total_dispositivos_aprobados": total_dispositivos,
    }


@router.post("/toggle-isolation")
def toggle_isolation_mode(body: ToggleAislamientoBody, db: Session = Depends(get_db)):
    """Activa o desactiva el modo de grupos aislados globalmente."""
    set_aislamiento_activo(db, body.activo)
    return {
        "ok": True,
        "aislamiento_activo": body.activo,
        "mensaje": "Modo de grupos aislados activado" if body.activo else "Modo de grupos aislados desactivado (Red abierta)"
    }


@router.get("/")
def list_groups(db: Session = Depends(get_db)):
    """Lista todos los grupos configurados con sus miembros, líder y estado."""
    grupos = db.query(GrupoRed).order_by(GrupoRed.creado_en.asc()).all()
    resultado = []

    for g in grupos:
        miembros_info = []
        lider_info = None

        for m in g.miembros:
            d = m.dispositivo
            if not d:
                continue
            en_linea = bool(d.sesiones and any(s.fin is None for s in d.sesiones))
            tipo_disp = deducir_tipo_dispositivo(d.nombre_host, d.direccion_mac)
            item = {
                "miembro_id": m.id,
                "dispositivo_id": d.id,
                "nombre_host": d.nombre_host or f"Estación {d.direccion_ip}",
                "direccion_ip": d.direccion_ip,
                "direccion_mac": d.direccion_mac,
                "rol": d.rol or "nivel_1",
                "tipo_dispositivo": tipo_disp,
                "en_linea": en_linea,
                "es_lider": m.es_lider,
            }
            miembros_info.append(item)
            if m.es_lider:
                lider_info = item

        resultado.append({
            "id": g.id,
            "nombre": g.nombre,
            "color": g.color,
            "esta_activo": g.esta_activo,
            "permite_archivos_lider": g.permite_archivos_lider,
            "permite_chat_admin": g.permite_chat_admin,
            "creado_en": g.creado_en,
            "lider": lider_info,
            "cantidad_miembros": len(miembros_info),
            "miembros": miembros_info,
        })

    return resultado


@router.get("/canvas-devices")
def get_canvas_devices(db: Session = Depends(get_db)):
    """
    Retorna todos los dispositivos aprobados con información de asignación a grupos
    para dibujar el mapa de red interactivo (nodos, conexiones y polígonos).
    """
    admin_macs = settings.admin_mac_list
    ahora = datetime.now()
    real_active_macs = routeros_client.get_mikrotik_active_network_macs()

    dispositivos = (
        db.query(Dispositivo)
        .filter(Dispositivo.estado == EstadoDispositivo.aprobado)
        .order_by(Dispositivo.id.asc())
        .all()
    )
    resultado = []

    for d in dispositivos:
        mac_norm = (d.direccion_mac or "").strip().upper()
        es_admin = mac_norm in admin_macs or d.rol == "admin"
        sesion_activa = any(s.fin is None for s in d.sesiones)
        actividad_reciente = d.ultima_actividad and (ahora - d.ultima_actividad).total_seconds() < 90
        esta_presente_red = es_admin or (mac_norm in real_active_macs) or check_ip_ping(d.direccion_ip)
        en_linea = es_admin or (esta_presente_red and (sesion_activa or bool(actividad_reciente)))
        tipo_disp = deducir_tipo_dispositivo(d.nombre_host, d.direccion_mac)

        # Buscar si pertenece a un grupo
        miembro = db.query(GrupoMiembro).filter(GrupoMiembro.dispositivo_id == d.id).first()
        grupo_id = None
        grupo_nombre = None
        grupo_color = None
        es_lider = False

        if miembro and miembro.grupo:
            grupo_id = miembro.grupo.id
            grupo_nombre = miembro.grupo.nombre
            grupo_color = miembro.grupo.color
            es_lider = miembro.es_lider

        resultado.append({
            "id": d.id,
            "nombre_host": d.nombre_host or f"Estación {d.direccion_ip}",
            "direccion_ip": d.direccion_ip,
            "direccion_mac": d.direccion_mac,
            "rol": d.rol or "nivel_1",
            "tipo_dispositivo": tipo_disp,
            "en_linea": en_linea,
            "grupo_id": grupo_id,
            "grupo_nombre": grupo_nombre,
            "grupo_color": grupo_color,
            "es_lider": es_lider,
        })

    return resultado


@router.post("/")
def create_group(body: CrearEditarGrupoBody, db: Session = Depends(get_db)):
    """Crea un nuevo grupo de trabajo con los dispositivos seleccionados y designa su líder."""
    if not body.nombre.strip():
        raise HTTPException(status_code=400, detail="El nombre del grupo es obligatorio")
    if not body.dispositivos_ids:
        raise HTTPException(status_code=400, detail="Debe seleccionar al menos 1 dispositivo para el grupo")

    # 1. Crear el grupo
    nuevo_grupo = GrupoRed(
        nombre=body.nombre.strip(),
        color=body.color or "#6366f1",
        esta_activo=body.esta_activo,
        permite_archivos_lider=body.permite_archivos_lider,
        permite_chat_admin=body.permite_chat_admin,
        creado_en=datetime.now(),
    )
    db.add(nuevo_grupo)
    db.flush()

    # 2. Desvincular los dispositivos de grupos anteriores (cada dispositivo pertenece a 1 solo grupo)
    db.query(GrupoMiembro).filter(GrupoMiembro.dispositivo_id.in_(body.dispositivos_ids)).delete(synchronize_session=False)

    # 3. Asignar los miembros y líder
    for dev_id in body.dispositivos_ids:
        es_lider = (body.lider_dispositivo_id is not None and dev_id == body.lider_dispositivo_id)
        miembro = GrupoMiembro(
            grupo_id=nuevo_grupo.id,
            dispositivo_id=dev_id,
            es_lider=es_lider,
        )
        db.add(miembro)

    # Si no se eligió líder explícito, se asigna el primero de la lista
    if not body.lider_dispositivo_id and body.dispositivos_ids:
        primer_miembro = db.query(GrupoMiembro).filter(
            GrupoMiembro.grupo_id == nuevo_grupo.id,
            GrupoMiembro.dispositivo_id == body.dispositivos_ids[0]
        ).first()
        if primer_miembro:
            primer_miembro.es_lider = True

    db.commit()
    db.refresh(nuevo_grupo)

    return {"ok": True, "grupo_id": nuevo_grupo.id, "mensaje": f"Grupo '{nuevo_grupo.nombre}' creado exitosamente"}


@router.put("/{group_id}")
def update_group(group_id: int, body: CrearEditarGrupoBody, db: Session = Depends(get_db)):
    """Actualiza configuración, miembros y líder de un grupo existente."""
    grupo = db.query(GrupoRed).filter(GrupoRed.id == group_id).first()
    if not grupo:
        raise HTTPException(status_code=404, detail="Grupo no encontrado")

    grupo.nombre = body.nombre.strip()
    grupo.color = body.color or grupo.color
    grupo.esta_activo = body.esta_activo
    grupo.permite_archivos_lider = body.permite_archivos_lider
    grupo.permite_chat_admin = body.permite_chat_admin

    # Actualizar miembros si se enviaron
    if body.dispositivos_ids is not None:
        # Desvincular miembros actuales del grupo
        db.query(GrupoMiembro).filter(GrupoMiembro.grupo_id == group_id).delete()

        # Desvincular de otros grupos los dispositivos elegidos
        db.query(GrupoMiembro).filter(GrupoMiembro.dispositivo_id.in_(body.dispositivos_ids)).delete(synchronize_session=False)

        # Crear nuevos miembros
        for dev_id in body.dispositivos_ids:
            es_lider = (body.lider_dispositivo_id is not None and dev_id == body.lider_dispositivo_id)
            miembro = GrupoMiembro(
                grupo_id=grupo.id,
                dispositivo_id=dev_id,
                es_lider=es_lider,
            )
            db.add(miembro)

    db.commit()
    return {"ok": True, "mensaje": f"Grupo '{grupo.nombre}' actualizado correctamente"}


@router.delete("/{group_id}")
def delete_group(group_id: int, db: Session = Depends(get_db)):
    """Elimina un grupo de trabajo y desvincula sus dispositivos miembros."""
    grupo = db.query(GrupoRed).filter(GrupoRed.id == group_id).first()
    if not grupo:
        raise HTTPException(status_code=404, detail="Grupo no encontrado")

    nombre = grupo.nombre
    db.delete(grupo)
    db.commit()
    return {"ok": True, "mensaje": f"Grupo '{nombre}' eliminado correctamente"}


# --- Endpoints de Mensajería y Chat Colaborativo (Portal y Admin) ---

@router.get("/chat/channels")
def get_chat_channels(request: Request, client_ip: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Retorna la lista de canales y contactos disponibles para chatear.
    Si el modo aislamiento está ACTIVO, filtra estrictamente al grupo del dispositivo.
    Si está DESACTIVADO, permite ver todos los dispositivos conectados y el canal general.
    """
    ip_origen = client_ip or obtener_ip_cliente(request)
    aislamiento_activo = get_aislamiento_activo(db)

    # Identificar el dispositivo solicitante
    dispositivo_propio = db.query(Dispositivo).filter(Dispositivo.direccion_ip == ip_origen).first()
    es_admin = ip_origen in ("127.0.0.1", "localhost", "::1")

    # Identificar si pertenece a un grupo
    mi_pertenencia = None
    if dispositivo_propio:
        mi_pertenencia = db.query(GrupoMiembro).filter(GrupoMiembro.dispositivo_id == dispositivo_propio.id).first()

    mi_grupo = mi_pertenencia.grupo if (mi_pertenencia and mi_pertenencia.grupo and mi_pertenencia.grupo.esta_activo) else None
    soy_lider = mi_pertenencia.es_lider if mi_pertenencia else False

    canales = []
    contactos = []

    if aislamiento_activo:
        # --- MODO AISLADO ACTIVO ---
        if not mi_grupo and not es_admin:
            return {
                "aislamiento_activo": True,
                "dispositivo": {
                    "ip": ip_origen,
                    "nombre": dispositivo_propio.nombre_host if dispositivo_propio else ip_origen,
                    "en_grupo": False,
                },
                "canales": [],
                "contactos": [],
                "aviso": "Tu estación no pertenece a ningún grupo de trabajo aislado actualmente. Espera a que el administrador te asigne a un grupo."
            }

        if mi_grupo:
            # 1. Canal del Grupo
            canales.append({
                "id": f"grupo_{mi_grupo.id}",
                "tipo": "grupo",
                "grupo_id": mi_grupo.id,
                "nombre": f"# 📢 {mi_grupo.nombre}",
                "color": mi_grupo.color,
                "descripcion": "Canal grupal de trabajo de tu equipo",
            })

            # 2. Contactos directos (solo compañeros de su mismo grupo)
            for m in mi_grupo.miembros:
                d = m.dispositivo
                if not d or (dispositivo_propio and d.id == dispositivo_propio.id):
                    continue
                en_linea = bool(d.sesiones and any(s.fin is None for s in d.sesiones))
                contactos.append({
                    "id": f"directo_{d.direccion_ip}",
                    "tipo": "directo",
                    "ip": d.direccion_ip,
                    "nombre": d.nombre_host or f"PC {d.direccion_ip}",
                    "es_lider": m.es_lider,
                    "en_linea": en_linea,
                    "tipo_dispositivo": deducir_tipo_dispositivo(d.nombre_host, d.direccion_mac),
                })

            # 3. Canal con el Administrador (Habilitado solo si es líder y el grupo lo permite)
            if soy_lider and mi_grupo.permite_chat_admin:
                canales.append({
                    "id": "admin_directo",
                    "tipo": "admin",
                    "nombre": "🛡️ Soporte con Administrador",
                    "color": "#ec4899",
                    "descripcion": "Canal directo exclusivo de líderes con el Administrador",
                })

    else:
        # --- MODO AISLADO DESACTIVADO (Red Abierta) ---
        canales.append({
            "id": "red_general",
            "tipo": "red_general",
            "nombre": "# 🌐 Red General de Laboratorio",
            "color": "#0ea5e9",
            "descripcion": "Canal abierto para todos los puestos conectados",
        })

        if mi_grupo:
            canales.append({
                "id": f"grupo_{mi_grupo.id}",
                "tipo": "grupo",
                "grupo_id": mi_grupo.id,
                "nombre": f"# 📢 {mi_grupo.nombre}",
                "color": mi_grupo.color,
                "descripcion": "Canal privado de tu mesa de trabajo",
            })

        # Listar todos los demás dispositivos aprobados en la red
        otros = db.query(Dispositivo).filter(Dispositivo.estado == EstadoDispositivo.aprobado).all()
        for d in otros:
            if dispositivo_propio and d.id == dispositivo_propio.id:
                continue
            en_linea = bool(d.sesiones and any(s.fin is None for s in d.sesiones))
            contactos.append({
                "id": f"directo_{d.direccion_ip}",
                "tipo": "directo",
                "ip": d.direccion_ip,
                "nombre": d.nombre_host or f"PC {d.direccion_ip}",
                "es_lider": False,
                "en_linea": en_linea,
                "tipo_dispositivo": deducir_tipo_dispositivo(d.nombre_host, d.direccion_mac),
            })

        # En modo abierto, cualquiera puede contactar al Admin
        canales.append({
            "id": "admin_directo",
            "tipo": "admin",
            "nombre": "🛡️ Canal Administrador",
            "color": "#ec4899",
            "descripcion": "Consultas directas a la consola central",
        })

    return {
        "aislamiento_activo": aislamiento_activo,
        "dispositivo": {
            "ip": ip_origen,
            "nombre": dispositivo_propio.nombre_host if dispositivo_propio else f"Estación {ip_origen}",
            "en_grupo": bool(mi_grupo is not None),
            "grupo_id": mi_grupo.id if mi_grupo else None,
            "grupo_nombre": mi_grupo.nombre if mi_grupo else None,
            "grupo_color": mi_grupo.color if mi_grupo else None,
            "es_lider": soy_lider,
            "puede_subir_archivos": bool(soy_lider and mi_grupo and mi_grupo.permite_archivos_lider),
            "puede_chatear_admin": bool(soy_lider and mi_grupo and mi_grupo.permite_chat_admin) or (not aislamiento_activo),
        },
        "canales": canales,
        "contactos": contactos,
    }


@router.get("/chat/messages")
def get_chat_messages(
    request: Request,
    canal_id: str,
    client_ip: Optional[str] = None,
    limite: int = 60,
    db: Session = Depends(get_db)
):
    """
    Retorna los mensajes de un canal o chat directo específico,
    validando permisos de aislamiento.
    """
    ip_origen = client_ip or obtener_ip_cliente(request)
    aislamiento_activo = get_aislamiento_activo(db)

    query = db.query(MensajeGrupo)

    if canal_id.startswith("grupo_"):
        try:
            gid = int(canal_id.split("_")[1])
        except Exception:
            raise HTTPException(status_code=400, detail="Identificador de grupo inválido")

        # Si el aislamiento está activo, validar que pertenezca a ese grupo
        if aislamiento_activo:
            dev = db.query(Dispositivo).filter(Dispositivo.direccion_ip == ip_origen).first()
            if dev:
                es_miembro = db.query(GrupoMiembro).filter(
                    GrupoMiembro.grupo_id == gid,
                    GrupoMiembro.dispositivo_id == dev.id
                ).first()
                if not es_miembro and ip_origen not in ("127.0.0.1", "localhost", "::1"):
                    raise HTTPException(status_code=403, detail="No tienes acceso a este grupo aislado")

        query = query.filter(MensajeGrupo.grupo_id == gid, MensajeGrupo.receptor_ip.is_(None))

    elif canal_id.startswith("directo_"):
        destino_ip = canal_id.replace("directo_", "").strip()
        # Mensajes directos bidireccionales entre ip_origen y destino_ip
        query = query.filter(
            ((MensajeGrupo.emisor_ip == ip_origen) & (MensajeGrupo.receptor_ip == destino_ip)) |
            ((MensajeGrupo.emisor_ip == destino_ip) & (MensajeGrupo.receptor_ip == ip_origen))
        )

    elif canal_id == "admin_directo":
        # Conversación directa con el Administrador
        query = query.filter(
            ((MensajeGrupo.emisor_ip == ip_origen) & (MensajeGrupo.receptor_ip == "admin")) |
            ((MensajeGrupo.emisor_ip == "admin") & (MensajeGrupo.receptor_ip == ip_origen))
        )

    elif canal_id == "red_general":
        query = query.filter(MensajeGrupo.grupo_id.is_(None), MensajeGrupo.receptor_ip.is_(None))

    else:
        raise HTTPException(status_code=400, detail="Canal de chat no reconocido")

    mensajes = query.order_by(MensajeGrupo.creado_en.asc()).limit(limite).all()

    return [
        {
            "id": m.id,
            "grupo_id": m.grupo_id,
            "emisor_ip": m.emisor_ip,
            "emisor_nombre": m.emisor_nombre,
            "es_propio": (m.emisor_ip == ip_origen),
            "receptor_ip": m.receptor_ip,
            "contenido": m.contenido,
            "archivo_nombre": m.archivo_nombre,
            "archivo_tamano": m.archivo_tamano,
            "tiene_archivo": bool(m.archivo_ruta and os.path.exists(m.archivo_ruta)),
            "creado_en": m.creado_en.isoformat(),
        }
        for m in mensajes
    ]


@router.post("/chat/messages")
def send_chat_message(
    body: EnviarMensajeBody,
    request: Request,
    client_ip: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """
    Envía un mensaje o comparte un archivo en el canal correspondiente.
    Valida permisos si se intenta subir un archivo (solo líderes o admin).
    """
    ip_origen = client_ip or obtener_ip_cliente(request)
    aislamiento_activo = get_aislamiento_activo(db)

    # Buscar nombre del remitente
    dev = db.query(Dispositivo).filter(Dispositivo.direccion_ip == ip_origen).first()
    emisor_nombre = dev.nombre_host if dev and dev.nombre_host else f"Estación {ip_origen}"
    emisor_mac = dev.direccion_mac if dev else None

    # Validar permisos de archivo si se adjunta uno
    archivo_ruta = None
    archivo_nombre = None
    archivo_tamano = 0

    if body.archivo_base64 and body.archivo_nombre:
        # Verificar si el emisor es líder
        es_lider = False
        mi_pertenencia = db.query(GrupoMiembro).filter(GrupoMiembro.dispositivo_id == dev.id).first() if dev else None
        if mi_pertenencia and mi_pertenencia.es_lider and mi_pertenencia.grupo.permite_archivos_lider:
            es_lider = True

        if not es_lider and ip_origen not in ("127.0.0.1", "localhost", "::1"):
            raise HTTPException(status_code=403, detail="Solo el líder del grupo tiene permisos para compartir archivos")

        try:
            contenido_bytes = base64.b64decode(body.archivo_base64)
            extension = os.path.splitext(body.archivo_nombre)[1]
            nombre_disco = f"chat_{uuid.uuid4().hex[:12]}{extension}"
            ruta_destino = os.path.join(CHAT_UPLOAD_DIR, nombre_disco)

            with open(ruta_destino, "wb") as f:
                f.write(contenido_bytes)

            archivo_ruta = ruta_destino
            archivo_nombre = body.archivo_nombre
            archivo_tamano = len(contenido_bytes)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Error al procesar el archivo adjunto: {str(e)}")

    grupo_id_dest = body.grupo_id
    receptor_ip_dest = body.receptor_ip

    if body.canal_tipo == "admin":
        receptor_ip_dest = "admin"
        grupo_id_dest = None
    elif body.canal_tipo == "red_general":
        receptor_ip_dest = None
        grupo_id_dest = None
    elif body.canal_tipo == "grupo":
        receptor_ip_dest = None

    nuevo_mensaje = MensajeGrupo(
        grupo_id=grupo_id_dest,
        emisor_ip=ip_origen,
        emisor_mac=emisor_mac,
        emisor_nombre=emisor_nombre,
        receptor_ip=receptor_ip_dest,
        contenido=body.contenido.strip(),
        archivo_nombre=archivo_nombre,
        archivo_ruta=archivo_ruta,
        archivo_tamano=archivo_tamano,
        creado_en=datetime.now(),
    )
    db.add(nuevo_mensaje)
    db.commit()
    db.refresh(nuevo_mensaje)

    return {
        "ok": True,
        "mensaje_id": nuevo_mensaje.id,
        "creado_en": nuevo_mensaje.creado_en.isoformat(),
    }


import mimetypes

@router.get("/chat/download/{mensaje_id}")
def download_chat_file(mensaje_id: int, db: Session = Depends(get_db)):
    """Permite a los miembros descargar un archivo compartido en el chat."""
    msg = db.query(MensajeGrupo).filter(MensajeGrupo.id == mensaje_id).first()
    if not msg or not msg.archivo_ruta or not os.path.exists(msg.archivo_ruta):
        raise HTTPException(status_code=404, detail="El archivo adjunto no existe o fue eliminado")

    nombre_descarga = msg.archivo_nombre or "archivo_compartido"
    tipo_mime, _ = mimetypes.guess_type(nombre_descarga)
    if not tipo_mime:
        tipo_mime = "application/octet-stream"

    return FileResponse(
        path=msg.archivo_ruta,
        filename=nombre_descarga,
        media_type=tipo_mime,
    )


@router.get("/admin/inbox")
def get_admin_inbox(db: Session = Depends(get_db)):
    """
    Devuelve para el panel de administración todos los mensajes recibidos desde las estaciones
    (tanto canal directo al admin como alertas/mensajes de la red), agrupados por estación.
    """
    mensajes = (
        db.query(MensajeGrupo)
        .filter((MensajeGrupo.receptor_ip == "admin") | (MensajeGrupo.emisor_ip == "admin"))
        .order_by(MensajeGrupo.creado_en.asc())
        .all()
    )

    conversaciones_map = {}
    for m in mensajes:
        ip_estacion = m.emisor_ip if m.emisor_ip != "admin" else m.receptor_ip
        if not ip_estacion:
            continue

        if ip_estacion not in conversaciones_map:
            dev = db.query(Dispositivo).filter(Dispositivo.direccion_ip == ip_estacion).first()
            nombre_disp = dev.nombre_host if (dev and dev.nombre_host) else (m.emisor_nombre or f"Estación {ip_estacion}")
            conversaciones_map[ip_estacion] = {
                "ip": ip_estacion,
                "nombre": nombre_disp,
                "mensajes": [],
                "ultimo_mensaje": "",
                "ultima_fecha": m.creado_en.isoformat(),
            }

        conversaciones_map[ip_estacion]["mensajes"].append({
            "id": m.id,
            "emisor": "admin" if m.emisor_ip == "admin" else "estacion",
            "emisor_nombre": "Administrador" if m.emisor_ip == "admin" else (m.emisor_nombre or f"Estación {ip_estacion}"),
            "contenido": m.contenido,
            "archivo_nombre": m.archivo_nombre,
            "archivo_tamano": m.archivo_tamano,
            "tiene_archivo": bool(m.archivo_ruta and os.path.exists(m.archivo_ruta)),
            "creado_en": m.creado_en.isoformat(),
        })
        conversaciones_map[ip_estacion]["ultimo_mensaje"] = m.contenido
        conversaciones_map[ip_estacion]["ultima_fecha"] = m.creado_en.isoformat()

    return list(conversaciones_map.values())


class AdminResponderChatBody(BaseModel):
    destino_ip: str
    contenido: str


@router.post("/admin/reply")
def reply_from_admin(body: AdminResponderChatBody, db: Session = Depends(get_db)):
    """Permite al Administrador responder a una estación en su canal directo."""
    if not body.contenido.strip():
        raise HTTPException(status_code=400, detail="El mensaje no puede estar vacío")

    nuevo = MensajeGrupo(
        emisor_ip="admin",
        emisor_nombre="Administrador del Laboratorio",
        receptor_ip=body.destino_ip.strip(),
        contenido=body.contenido.strip(),
        creado_en=datetime.now(),
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    return {"ok": True, "id": nuevo.id, "creado_en": nuevo.creado_en.isoformat()}
