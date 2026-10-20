from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import PoliticaRol, Dispositivo, EstadoDispositivo, Sesion
from app.config import settings
from app import routeros_client

router = APIRouter(prefix="/roles", tags=["roles"])


class PoliticaUpdate(BaseModel):
    nombre_visible: str | None = None
    descripcion: str | None = None
    tiempo_defecto_minutos: int | None = None  # 0 o None = ilimitado
    velocidad_defecto_mbps: int | None = None  # 0 o None = ilimitado
    exento_filtro_defecto: bool | None = None
    permite_reacceso: bool | None = None


DEFAULT_POLICIES = [
    {
        "rol": "nivel_1",
        "nombre_visible": "Nivel 1 (Estándar / Operativo / Alumnos)",
        "descripcion": "Estudiantes, empleados o invitados. Parámetros estándar de navegación con filtrado web y límite de tiempo.",
        "tiempo_defecto_minutos": 120,
        "velocidad_defecto_mbps": 10,
        "exento_filtro_defecto": False,
        "permite_reacceso": True,
    },
    {
        "rol": "nivel_2",
        "nombre_visible": "Nivel 2 (Supervisión / Docentes / Jefes)",
        "descripcion": "Docentes, jefes de área o instructores. Conexión continua sin cortes de tiempo ni limitaciones de contenido.",
        "tiempo_defecto_minutos": 0,
        "velocidad_defecto_mbps": 0,
        "exento_filtro_defecto": True,
        "permite_reacceso": True,
    },
    {
        "rol": "admin",
        "nombre_visible": "Administrador (Pase Libre Total)",
        "descripcion": "Estación de control del administrador. Acceso irrestricto, bypass de firewall, velocidad máxima y sin bloqueos de red.",
        "tiempo_defecto_minutos": 0,
        "velocidad_defecto_mbps": 0,
        "exento_filtro_defecto": True,
        "permite_reacceso": True,
    },
]


def asegurar_politicas_base(db: Session):
    for item in DEFAULT_POLICIES:
        existente = db.query(PoliticaRol).filter(PoliticaRol.rol == item["rol"]).first()
        if not existente:
            nueva = PoliticaRol(
                rol=item["rol"],
                nombre_visible=item["nombre_visible"],
                descripcion=item["descripcion"],
                tiempo_defecto_minutos=item["tiempo_defecto_minutos"],
                velocidad_defecto_mbps=item["velocidad_defecto_mbps"],
                exento_filtro_defecto=item["exento_filtro_defecto"],
                permite_reacceso=item["permite_reacceso"],
                actualizado_en=datetime.now(),
            )
            db.add(nueva)
    db.commit()


@router.get("/policies")
def list_role_policies(db: Session = Depends(get_db)):
    """Obtiene las políticas y permisos configurados para cada rol/nivel del sistema."""
    asegurar_politicas_base(db)
    politicas = db.query(PoliticaRol).all()
    # Ordenar: nivel_1, nivel_2, admin
    orden = {"nivel_1": 1, "nivel_2": 2, "admin": 3}
    return sorted(politicas, key=lambda p: orden.get(p.rol, 99))


@router.put("/policies/{rol}")
def update_role_policy(rol: str, data: PoliticaUpdate, db: Session = Depends(get_db)):
    """Actualiza la configuración y permisos por defecto de un rol específico."""
    asegurar_politicas_base(db)
    rol_norm = rol.strip().lower()

    if rol_norm == "admin":
        # REGLA DE ORO: El Administrador tiene Pase Libre absoluto e inmutable
        raise HTTPException(
            status_code=400,
            detail="La política del rol Administrador está blindada con Pase Libre permanente y no puede ser restringida.",
        )

    politica = db.query(PoliticaRol).filter(PoliticaRol.rol == rol_norm).first()
    if not politica:
        raise HTTPException(status_code=404, detail=f"Rol '{rol}' no encontrado.")

    if data.nombre_visible is not None:
        politica.nombre_visible = data.nombre_visible.strip()
    if data.descripcion is not None:
        politica.descripcion = data.descripcion.strip()
    if data.tiempo_defecto_minutos is not None:
        politica.tiempo_defecto_minutos = data.tiempo_defecto_minutos
    if data.velocidad_defecto_mbps is not None:
        politica.velocidad_defecto_mbps = data.velocidad_defecto_mbps
    if data.exento_filtro_defecto is not None:
        politica.exento_filtro_defecto = data.exento_filtro_defecto
    if data.permite_reacceso is not None:
        politica.permite_reacceso = data.permite_reacceso

    politica.actualizado_en = datetime.now()

    # Propagar cambios de velocidad y exención a todos los dispositivos y sesiones activas del rol
    dispositivos_rol = db.query(Dispositivo).filter(Dispositivo.rol == rol_norm).all()
    for dev in dispositivos_rol:
        if data.velocidad_defecto_mbps is not None:
            dev.limite_velocidad_mbps = data.velocidad_defecto_mbps
        if data.exento_filtro_defecto is not None:
            dev.exento_filtro = data.exento_filtro_defecto

        # Actualizar sesión activa
        sesion_activa = (
            db.query(Sesion)
            .filter(Sesion.dispositivo_id == dev.id, Sesion.fin.is_(None))
            .first()
        )
        if sesion_activa:
            if data.velocidad_defecto_mbps is not None:
                sesion_activa.limite_velocidad_mbps = data.velocidad_defecto_mbps
            # Si el equipo está aprobado y tiene IP, actualizar Simple Queue en MikroTik de inmediato
            if dev.estado == EstadoDispositivo.aprobado and dev.direccion_ip:
                try:
                    routeros_client.set_bandwidth_limit(dev.direccion_ip, data.velocidad_defecto_mbps)
                except Exception as ex_qos:
                    print(f"Error actualizando QoS en MikroTik para {dev.direccion_ip}:", ex_qos)

    # Si cambió la política de exención de filtro web, resincronizar en MikroTik
    if data.exento_filtro_defecto is not None:
        try:
            from app.routers.web_filter import sync_all_whitelist_to_router
            sync_all_whitelist_to_router(db)
        except Exception as ex_sync:
            print("Error sincronizando filtro tras actualizar política:", ex_sync)

    db.commit()
    db.refresh(politica)

    return {"ok": True, "politica": politica, "mensaje": f"Política de {politica.nombre_visible} actualizada correctamente"}
