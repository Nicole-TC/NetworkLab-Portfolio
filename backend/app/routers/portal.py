from datetime import datetime
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, Dispositivo, Sesion, DominioBloqueado, EstadoDispositivo
from app.auth import requiere_usuario

router = APIRouter(prefix="/portal", tags=["portal_alumno"])


@router.get("/mi-estado")
def obtener_estado_alumno(
    usuario: Usuario = Depends(requiere_usuario),
    db: Session = Depends(get_db),
):
    """
    Devuelve la información de sesión, tiempo restante, velocidad QoS
    y lista de sitios restringidos para el usuario alumno autenticado.
    """
    ahora = datetime.now()

    # Buscar si tiene un dispositivo o sesión activa
    sesion_activa = (
        db.query(Sesion)
        .filter(
            (Sesion.usuario_id == usuario.id) | (Sesion.dispositivo.has(usuario_id=usuario.id)),
            Sesion.fin.is_(None),
        )
        .order_by(Sesion.inicio.desc())
        .first()
    )

    # Si no tiene sesión asignada específicamente a su ID, tomamos la última sesión activa general
    # para que en el entorno de laboratorio el alumno conectado a la PC vea su estado real
    if not sesion_activa:
        sesion_activa = db.query(Sesion).filter(Sesion.fin.is_(None)).order_by(Sesion.inicio.desc()).first()

    tiempo_restante_segundos = None
    segundos_transcurridos = 0
    limite_minutos = None
    limite_velocidad = None
    esta_expirada = False
    dispositivo_info = None

    if sesion_activa:
        segundos_transcurridos = int((ahora - sesion_activa.inicio).total_seconds())
        limite_minutos = sesion_activa.limite_tiempo_minutos
        limite_velocidad = sesion_activa.limite_velocidad_mbps
        esta_expirada = sesion_activa.esta_expirada

        if limite_minutos is not None and limite_minutos > 0:
            total_permitido = limite_minutos * 60
            tiempo_restante_segundos = max(0, total_permitido - segundos_transcurridos)
            if tiempo_restante_segundos <= 0:
                esta_expirada = True

        if sesion_activa.dispositivo:
            dispositivo_info = {
                "nombre_host": sesion_activa.dispositivo.nombre_host or "Computadora de Laboratorio",
                "direccion_ip": sesion_activa.direccion_ip or sesion_activa.dispositivo.direccion_ip,
                "direccion_mac": sesion_activa.dispositivo.direccion_mac,
                "estado": sesion_activa.dispositivo.estado.value,
            }

    # Obtener lista de dominios y categorías bloqueadas en el MikroTik
    dominios_db = (
        db.query(DominioBloqueado)
        .filter(DominioBloqueado.esta_activo == True)
        .order_by(DominioBloqueado.categoria.asc(), DominioBloqueado.dominio.asc())
        .all()
    )

    categorias_bloqueadas = sorted(list({d.categoria or "General" for d in dominios_db}))
    lista_dominios = [
        {"dominio": d.dominio, "categoria": d.categoria or "General"}
        for d in dominios_db
    ]

    return {
        "usuario": {
            "id": usuario.id,
            "nombre_usuario": usuario.nombre_usuario,
            "nombre_completo": usuario.nombre_completo or usuario.nombre_usuario,
            "rol": usuario.rol.value,
        },
        "dispositivo": dispositivo_info or {
            "nombre_host": "Estación de Trabajo",
            "direccion_ip": "Conectado a la Red",
            "direccion_mac": "—",
            "estado": "aprobado",
        },
        "tiempo": {
            "limite_tiempo_minutos": limite_minutos,
            "segundos_transcurridos": segundos_transcurridos,
            "tiempo_restante_segundos": tiempo_restante_segundos,
            "esta_expirada": esta_expirada,
            "es_ilimitado": limite_minutos is None,
        },
        "velocidad": {
            "limite_mbps": limite_velocidad,
            "es_ilimitada": limite_velocidad is None,
            "descripcion": f"{limite_velocidad} Mbps asignados (Control QoS)" if limite_velocidad else "Velocidad estándar del laboratorio",
        },
        "filtrado_web": {
            "total_bloqueados": len(lista_dominios),
            "categorias_restringidas": categorias_bloqueadas,
            "dominios_bloqueados": lista_dominios,
        },
    }
