from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, RolUsuario
from app.auth import (
    verificar_clave,
    hashear_clave,
    crear_token_acceso,
    requiere_usuario,
    requiere_admin,
)

router = APIRouter(prefix="/auth", tags=["autenticacion"])


class LoginRequest(BaseModel):
    nombre_usuario: Optional[str] = None
    username: Optional[str] = None
    clave: Optional[str] = None
    password: Optional[str] = None


class UsuarioCreate(BaseModel):
    nombre_usuario: str
    clave: str
    rol: str = "alumno"  # admin o alumno
    nombre_completo: Optional[str] = None


class UsuarioResponse(BaseModel):
    id: int
    nombre_usuario: str
    rol: str
    nombre_completo: Optional[str]
    creado_en: datetime
    esta_activo: bool


@router.post("/login")
def login(datos: LoginRequest, db: Session = Depends(get_db)):
    usuario_input = (datos.nombre_usuario or datos.username or "").strip()
    clave_input = datos.clave or datos.password or ""

    if not usuario_input or not clave_input:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Se requiere nombre de usuario y contraseña",
        )

    usuario = db.query(Usuario).filter(Usuario.nombre_usuario == usuario_input).first()
    if not usuario or not verificar_clave(clave_input, usuario.clave_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas",
        )

    if not usuario.esta_activo:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="La cuenta se encuentra inactiva",
        )

    token = crear_token_acceso(
        datos={"sub": usuario.nombre_usuario, "rol": usuario.rol.value, "id": usuario.id}
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "usuario": {
            "id": usuario.id,
            "nombre_usuario": usuario.nombre_usuario,
            "rol": usuario.rol.value,
            "nombre_completo": usuario.nombre_completo or usuario.nombre_usuario,
        },
    }


@router.get("/perfil")
def obtener_perfil(usuario: Usuario = Depends(requiere_usuario)):
    return {
        "id": usuario.id,
        "nombre_usuario": usuario.nombre_usuario,
        "rol": usuario.rol.value,
        "nombre_completo": usuario.nombre_completo,
        "creado_en": usuario.creado_en,
        "esta_activo": usuario.esta_activo,
    }


@router.get("/usuarios")
def listar_usuarios(
    usuario_admin: Usuario = Depends(requiere_admin),
    db: Session = Depends(get_db),
):
    usuarios = db.query(Usuario).order_by(Usuario.id.asc()).all()
    return [
        {
            "id": u.id,
            "nombre_usuario": u.nombre_usuario,
            "rol": u.rol.value,
            "nombre_completo": u.nombre_completo,
            "creado_en": u.creado_en,
            "esta_activo": u.esta_activo,
        }
        for u in usuarios
    ]


@router.post("/usuarios")
def crear_usuario(
    datos: UsuarioCreate,
    usuario_admin: Usuario = Depends(requiere_admin),
    db: Session = Depends(get_db),
):
    nombre_limpio = datos.nombre_usuario.strip()
    if not nombre_limpio or not datos.clave:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nombre de usuario y contraseña son obligatorios",
        )

    existente = db.query(Usuario).filter(Usuario.nombre_usuario == nombre_limpio).first()
    if existente:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El nombre de usuario ya existe",
        )

    rol_input = (datos.rol or "nivel_1").lower().strip()
    if rol_input == "admin":
        rol_enum = RolUsuario.admin
    elif rol_input in ("nivel_2", "docente"):
        rol_enum = RolUsuario.nivel_2
    else:
        rol_enum = RolUsuario.nivel_1

    nuevo_usuario = Usuario(
        nombre_usuario=nombre_limpio,
        clave_hash=hashear_clave(datos.clave),
        rol=rol_enum,
        nombre_completo=datos.nombre_completo or nombre_limpio,
        creado_en=datetime.now(),
        esta_activo=True,
    )
    db.add(nuevo_usuario)
    db.commit()
    db.refresh(nuevo_usuario)

    return {
        "ok": True,
        "usuario": {
            "id": nuevo_usuario.id,
            "nombre_usuario": nuevo_usuario.nombre_usuario,
            "rol": nuevo_usuario.rol.value,
            "nombre_completo": nuevo_usuario.nombre_completo,
        },
    }


@router.delete("/usuarios/{user_id}")
def eliminar_usuario(
    user_id: int,
    usuario_admin: Usuario = Depends(requiere_admin),
    db: Session = Depends(get_db),
):
    if user_id == usuario_admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No puedes eliminar tu propia cuenta de administrador",
        )

    u = db.query(Usuario).filter(Usuario.id == user_id).first()
    if not u:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado")

    db.delete(u)
    db.commit()

    return {"ok": True, "usuario_id": user_id, "mensaje": "Usuario eliminado correctamente"}
