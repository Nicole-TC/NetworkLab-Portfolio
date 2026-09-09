import os
from datetime import datetime, timedelta
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, RolUsuario

SECRET_KEY = os.getenv("JWT_SECRET", "lab2_secret_key_jwt_microtik_tacuri_2026")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 horas

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)


def verificar_clave(clave_plana: str, clave_hash: str) -> bool:
    try:
        return pwd_context.verify(clave_plana, clave_hash)
    except Exception:
        # Fallback simple para compatibilidad
        return clave_plana == clave_hash


def hashear_clave(clave_plana: str) -> str:
    return pwd_context.hash(clave_plana)


def crear_token_acceso(datos: dict, expira_delta: Optional[timedelta] = None) -> str:
    a_codificar = datos.copy()
    if expira_delta:
        expira = datetime.utcnow() + expira_delta
    else:
        expira = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    a_codificar.update({"exp": expira})
    token_codificado = jwt.encode(a_codificar, SECRET_KEY, algorithm=ALGORITHM)
    return token_codificado


def obtener_usuario_actual(
    credenciales: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> Optional[Usuario]:
    if not credenciales:
        return None

    token = credenciales.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        nombre_usuario: str = payload.get("sub")
        if nombre_usuario is None:
            return None
    except Exception:
        return None

    usuario = db.query(Usuario).filter(Usuario.nombre_usuario == nombre_usuario).first()
    if usuario is None or not usuario.esta_activo:
        return None

    return usuario


def requiere_usuario(usuario: Optional[Usuario] = Depends(obtener_usuario_actual)) -> Usuario:
    if not usuario:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No autorizado o sesión expirada",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return usuario


def requiere_admin(usuario: Usuario = Depends(requiere_usuario)) -> Usuario:
    if usuario.rol != RolUsuario.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acceso denegado: se requieren permisos de Administrador",
        )
    return usuario
