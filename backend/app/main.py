from datetime import datetime, timedelta
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import Base, engine, SessionLocal
from app.models import Usuario, RolUsuario
from app.auth import hashear_clave
from app.routers import devices, sessions, web_filter, auth, stats, portal, roles, files, messages, activity, groups

Base.metadata.create_all(bind=engine)

# Garantizar compatibilidad y creación de tablas en español si no existen
try:
    with engine.connect() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS usuarios (
                    id SERIAL PRIMARY KEY,
                    nombre_usuario VARCHAR UNIQUE NOT NULL,
                    clave_hash VARCHAR NOT NULL,
                    rol VARCHAR NOT NULL DEFAULT 'alumno',
                    nombre_completo VARCHAR,
                    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    esta_activo BOOLEAN DEFAULT TRUE
                );
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
                ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
                ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS limite_tiempo_minutos INTEGER;
                ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS esta_expirada BOOLEAN DEFAULT FALSE;
                ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS limite_velocidad_mbps INTEGER;
                ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS tiempo_activo_segundos INTEGER DEFAULT 0;
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS limite_velocidad_mbps INTEGER;
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS exento_filtro BOOLEAN DEFAULT FALSE;
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS rol VARCHAR DEFAULT 'nivel_1';
                UPDATE dispositivos SET usuario_id = NULL, nombre_host = '' WHERE direccion_mac = '16:13:C0:86:B9:89';
                -- Cerrar sesiones huérfanas legadas que quedaron abiertas por más de 12 horas en pruebas pasadas
                UPDATE sesiones 
                SET fin = inicio + INTERVAL '2 hours',
                    tiempo_activo_segundos = 5400,
                    esta_expirada = TRUE
                WHERE fin IS NULL AND inicio < CURRENT_TIMESTAMP - INTERVAL '12 hours';
                CREATE TABLE IF NOT EXISTS dominios_bloqueados (

                    id SERIAL PRIMARY KEY,
                    dominio VARCHAR UNIQUE NOT NULL,
                    categoria VARCHAR,
                    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    esta_activo BOOLEAN DEFAULT TRUE
                );
                ALTER TABLE dominios_bloqueados ADD COLUMN IF NOT EXISTS alcance VARCHAR DEFAULT 'todos';
                ALTER TABLE dominios_bloqueados ADD COLUMN IF NOT EXISTS dispositivos_ids VARCHAR DEFAULT '';
                ALTER TABLE dominios_bloqueados ADD COLUMN IF NOT EXISTS tipo VARCHAR DEFAULT 'blanca';
                CREATE TABLE IF NOT EXISTS politicas_roles (
                    id SERIAL PRIMARY KEY,
                    rol VARCHAR UNIQUE NOT NULL,
                    nombre_visible VARCHAR NOT NULL,
                    descripcion VARCHAR,
                    tiempo_defecto_minutos INTEGER DEFAULT 120,
                    velocidad_defecto_mbps INTEGER DEFAULT 10,
                    exento_filtro_defecto BOOLEAN DEFAULT FALSE,
                    permite_reacceso BOOLEAN DEFAULT TRUE,
                    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS archivos_compartidos (
                    id SERIAL PRIMARY KEY,
                    nombre_archivo VARCHAR NOT NULL,
                    nombre_original VARCHAR NOT NULL,
                    descripcion VARCHAR,
                    tamano_bytes INTEGER DEFAULT 0,
                    tipo_mime VARCHAR,
                    alcance VARCHAR DEFAULT 'todos',
                    fecha_subida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    subido_por VARCHAR DEFAULT 'admin'
                );
                CREATE TABLE IF NOT EXISTS mensajes_red (
                    id SERIAL PRIMARY KEY,
                    titulo VARCHAR NOT NULL,
                    contenido VARCHAR NOT NULL,
                    tipo VARCHAR DEFAULT 'info',
                    alcance VARCHAR DEFAULT 'todos',
                    dispositivo_id INTEGER,
                    direccion_ip VARCHAR,
                    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    activo BOOLEAN DEFAULT TRUE,
                    creado_por VARCHAR DEFAULT 'admin'
                );
                CREATE TABLE IF NOT EXISTS mensaje_lecturas (
                    id SERIAL PRIMARY KEY,
                    mensaje_id INTEGER NOT NULL REFERENCES mensajes_red(id) ON DELETE CASCADE,
                    direccion_ip VARCHAR,
                    direccion_mac VARCHAR,
                    nombre_dispositivo VARCHAR,
                    leido_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS registro_actividad_app (
                    id SERIAL PRIMARY KEY,
                    dispositivo_id INTEGER NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
                    fecha DATE DEFAULT CURRENT_DATE,
                    categoria VARCHAR NOT NULL,
                    aplicacion VARCHAR NOT NULL,
                    segundos_activos INTEGER DEFAULT 0,
                    bytes_in BIGINT DEFAULT 0,
                    bytes_out BIGINT DEFAULT 0,
                    ultima_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS configuracion_modulos (
                    clave VARCHAR PRIMARY KEY,
                    valor VARCHAR NOT NULL,
                    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS grupos_red (
                    id SERIAL PRIMARY KEY,
                    nombre VARCHAR NOT NULL,
                    color VARCHAR DEFAULT '#6366f1' NOT NULL,
                    esta_activo BOOLEAN DEFAULT TRUE NOT NULL,
                    permite_archivos_lider BOOLEAN DEFAULT TRUE NOT NULL,
                    permite_chat_admin BOOLEAN DEFAULT TRUE NOT NULL,
                    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
                );
                CREATE TABLE IF NOT EXISTS grupo_miembros (
                    id SERIAL PRIMARY KEY,
                    grupo_id INTEGER NOT NULL REFERENCES grupos_red(id) ON DELETE CASCADE,
                    dispositivo_id INTEGER NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
                    es_lider BOOLEAN DEFAULT FALSE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mensajes_grupo (
                    id SERIAL PRIMARY KEY,
                    grupo_id INTEGER REFERENCES grupos_red(id) ON DELETE CASCADE,
                    emisor_ip VARCHAR NOT NULL,
                    emisor_mac VARCHAR,
                    emisor_nombre VARCHAR NOT NULL,
                    receptor_ip VARCHAR,
                    contenido TEXT NOT NULL,
                    archivo_nombre VARCHAR,
                    archivo_ruta VARCHAR,
                    archivo_tamano INTEGER DEFAULT 0 NOT NULL,
                    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
                );
                DO $$
                BEGIN
                    ALTER TYPE rolusuario ADD VALUE IF NOT EXISTS 'nivel_1';
                    ALTER TYPE rolusuario ADD VALUE IF NOT EXISTS 'nivel_2';
                EXCEPTION
                    WHEN duplicate_object THEN null;
                    WHEN undefined_object THEN null;
                END $$;
                """
            )
        )
        conn.commit()
except Exception as e:
    print(f"Nota sobre migración de esquema: {e}")


def sembrar_usuarios_iniciales():
    """Crea las cuentas iniciales y políticas de roles por defecto si no existen."""
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

        db.commit()
    except Exception as e:
        print(f"Error al sembrar datos iniciales: {e}")
        db.rollback()
    finally:
        db.close()


sembrar_usuarios_iniciales()

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


