from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import Base, engine, SessionLocal
from app.models import Usuario, RolUsuario
from app.auth import hashear_clave
from app.routers import devices, sessions, web_filter, auth, stats, portal, roles, files, messages

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
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS limite_velocidad_mbps INTEGER;
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS exento_filtro BOOLEAN DEFAULT FALSE;
                ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS rol VARCHAR DEFAULT 'nivel_1';
                UPDATE dispositivos SET usuario_id = NULL, nombre_host = '' WHERE direccion_mac = '16:13:C0:86:B9:89';
                CREATE TABLE IF NOT EXISTS dominios_bloqueados (

                    id SERIAL PRIMARY KEY,
                    dominio VARCHAR UNIQUE NOT NULL,
                    categoria VARCHAR,
                    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    esta_activo BOOLEAN DEFAULT TRUE
                );
                ALTER TABLE dominios_bloqueados ADD COLUMN IF NOT EXISTS alcance VARCHAR DEFAULT 'todos';
                ALTER TABLE dominios_bloqueados ADD COLUMN IF NOT EXISTS dispositivos_ids VARCHAR DEFAULT '';
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

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(sessions.router)
app.include_router(web_filter.router)
app.include_router(stats.router)
app.include_router(portal.router)
app.include_router(roles.router)
app.include_router(files.router)
app.include_router(messages.router)


@app.get("/health")
def health_check():
    return {"status": "ok", "version": "0.2.0"}


@app.get("/router/status")
def router_status():
    """Retorna el estado de conectividad en tiempo real con el router MikroTik."""
    from app import routeros_client
    return routeros_client.check_router_connection()


