from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import Base, engine, SessionLocal
from app.models import Usuario, RolUsuario
from app.auth import hashear_clave
from app.routers import devices, sessions, web_filter, auth, stats, portal

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
                CREATE TABLE IF NOT EXISTS dominios_bloqueados (
                    id SERIAL PRIMARY KEY,
                    dominio VARCHAR UNIQUE NOT NULL,
                    categoria VARCHAR,
                    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    esta_activo BOOLEAN DEFAULT TRUE
                );
                """
            )
        )
        conn.commit()
except Exception as e:
    print(f"Nota sobre migración de esquema: {e}")


def sembrar_usuarios_iniciales():
    """Crea las cuentas iniciales por defecto si no existen en la base de datos."""
    db: Session = SessionLocal()
    try:
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
        print(f"Error al sembrar usuarios iniciales: {e}")
        db.rollback()
    finally:
        db.close()


sembrar_usuarios_iniciales()

app = FastAPI(title="Lab Network Panel", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


@app.get("/health")
def health_check():
    return {"status": "ok", "version": "0.2.0"}
