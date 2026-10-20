from datetime import datetime, timedelta
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.database import Base, engine, SessionLocal
from app.models import Usuario, RolUsuario, Sesion
from app.auth import hashear_clave
from app.routers import devices, sessions, web_filter, auth, stats, portal, roles, files, messages, activity, groups

# Creación de tablas de forma declarativa mediante SQLAlchemy ORM
Base.metadata.create_all(bind=engine)


def inicializar_datos_sistema():
    """Inicializa políticas de roles, cuentas por defecto y cierra sesiones obsoletas."""
    db: Session = SessionLocal()
    try:
        roles.asegurar_politicas_base(db)
        admin_existe = db.query(Usuario).filter(Usuario.nombre_usuario == "admin").first()
        if not admin_existe:
            admin_user = Usuario(
                nombre_usuario="admin",
                clave_hash=hashear_clave("admin123"),
                rol=RolUsuario.admin,
                nombre_completo="Administrador del Laboratorio",
                esta_activo=True,
            )
            db.add(admin_user)

        alumno_existe = db.query(Usuario).filter(Usuario.nombre_usuario == "alumno1").first()
        if not alumno_existe:
            alumno_user = Usuario(
                nombre_usuario="alumno1",
                clave_hash=hashear_clave("alumno123"),
                rol=RolUsuario.alumno,
                nombre_completo="Alumno 1 (PC-01)",
                esta_activo=True,
            )
            db.add(alumno_user)

        # Cerrar sesiones huérfanas legadas abiertas hace más de 12 horas
        hace_12_horas = datetime.now() - timedelta(hours=12)
        sesiones_huerfanas = (
            db.query(Sesion)
            .filter(Sesion.fin.is_(None), Sesion.inicio < hace_12_horas)
            .all()
        )
        for s in sesiones_huerfanas:
            s.fin = s.inicio + timedelta(hours=2)
            s.tiempo_activo_segundos = 5400
            s.esta_expirada = True

        db.commit()
    except Exception as e:
        print(f"Nota en inicialización de datos: {e}")
        db.rollback()
    finally:
        db.close()


inicializar_datos_sistema()

app = FastAPI(title="Lab Network Panel", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def track_client_activity(request: Request, call_next):
    """Rastrea de forma transparente la actividad real de las estaciones conectadas a la red."""
    response = await call_next(request)
    path = request.url.path
    if not (path.startswith("/health") or path.startswith("/favicon") or path.startswith("/static")):
        try:
            client_ip = None
            forwarded = request.headers.get("x-forwarded-for")
            if forwarded:
                client_ip = forwarded.split(",")[0].strip()
            elif request.client:
                client_ip = request.client.host

            if client_ip and client_ip not in ("127.0.0.1", "localhost", "::1"):
                from app.models import Dispositivo, Sesion, EstadoDispositivo
                db_mid = SessionLocal()
                try:
                    dev = db_mid.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()
                    if dev:
                        ahora = datetime.now()
                        dev.ultima_actividad = ahora
                        sesion = (
                            db_mid.query(Sesion)
                            .filter(Sesion.dispositivo_id == dev.id, Sesion.fin.is_(None))
                            .order_by(Sesion.inicio.desc())
                            .first()
                        )
                        if not sesion and (getattr(dev, "rol", "") == "admin" or dev.estado == EstadoDispositivo.aprobado):
                            # Abrir sesión activa para la jornada actual si no tenía una abierta
                            sesion = Sesion(
                                dispositivo_id=dev.id,
                                direccion_ip=client_ip,
                                inicio=ahora,
                                ultimo_pulso=ahora,
                                tiempo_activo_segundos=15,
                                esta_expirada=False,
                            )
                            db_mid.add(sesion)
                        elif sesion:
                            ultimo = sesion.ultimo_pulso or sesion.inicio
                            delta = (ahora - ultimo).total_seconds()
                            if 0 < delta <= 90:
                                sesion.tiempo_activo_segundos = (getattr(sesion, "tiempo_activo_segundos", 0) or 0) + int(delta)
                            elif delta > 90:
                                sesion.tiempo_activo_segundos = (getattr(sesion, "tiempo_activo_segundos", 0) or 0) + 5
                            sesion.ultimo_pulso = ahora
                        db_mid.commit()
                finally:
                    db_mid.close()
        except Exception:
            pass
    return response

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(sessions.router)
app.include_router(web_filter.router)
app.include_router(stats.router)
app.include_router(portal.router)
app.include_router(roles.router)
app.include_router(files.router)
app.include_router(messages.router)
app.include_router(activity.router)
app.include_router(groups.router)


@app.get("/health")
def health_check():
    return {"status": "ok", "version": "0.2.0"}


@app.get("/router/status")
def router_status():
    """Retorna el estado de conectividad en tiempo real con el router MikroTik."""
    from app import routeros_client
    return routeros_client.check_router_connection()


