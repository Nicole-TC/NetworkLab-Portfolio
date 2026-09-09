import enum
from datetime import datetime

from sqlalchemy import Column, Integer, String, Enum, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from app.database import Base


class EstadoDispositivo(str, enum.Enum):
    pendiente = "pendiente"
    aprobado = "aprobado"
    rechazado = "rechazado"


class RolUsuario(str, enum.Enum):
    admin = "admin"
    alumno = "alumno"


class Usuario(Base):
    """
    Representa un usuario del sistema (Administrador o Alumno/Usuario de PC).
    Tabla en plural: usuarios. Campos en singular.
    """
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    nombre_usuario = Column(String, unique=True, index=True, nullable=False)
    clave_hash = Column(String, nullable=False)
    rol = Column(Enum(RolUsuario), default=RolUsuario.alumno, nullable=False)
    nombre_completo = Column(String, nullable=True)
    creado_en = Column(DateTime, default=datetime.now, nullable=False)
    esta_activo = Column(Boolean, default=True, nullable=False)

    dispositivos = relationship("Dispositivo", back_populates="usuario")
    sesiones = relationship("Sesion", back_populates="usuario")


class Dispositivo(Base):
    """
    Representa un equipo físico que se conecta a la red del laboratorio.
    Tabla en plural: dispositivos. Campos en singular.
    """
    __tablename__ = "dispositivos"

    id = Column(Integer, primary_key=True, index=True)
    direccion_mac = Column(String, unique=True, index=True, nullable=False)
    direccion_ip = Column(String, nullable=True)
    nombre_host = Column(String, nullable=True)
    estado = Column(Enum(EstadoDispositivo), default=EstadoDispositivo.pendiente, nullable=False)
    primera_conexion = Column(DateTime, default=datetime.now)
    ultima_actividad = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    limite_velocidad_mbps = Column(Integer, nullable=True)  # None = Ilimitado
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)

    usuario = relationship("Usuario", back_populates="dispositivos")
    sesiones = relationship("Sesion", back_populates="dispositivo")


class Sesion(Base):
    """
    Representa una conexión continua de un dispositivo a la red.
    Tabla en plural: sesiones. Campos en singular.
    """
    __tablename__ = "sesiones"

    id = Column(Integer, primary_key=True, index=True)
    dispositivo_id = Column(Integer, ForeignKey("dispositivos.id"), nullable=False)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    direccion_ip = Column(String, nullable=True)
    inicio = Column(DateTime, default=datetime.now, nullable=False)
    ultimo_pulso = Column(DateTime, default=datetime.now, nullable=False)
    fin = Column(DateTime, nullable=True)
    limite_tiempo_minutos = Column(Integer, nullable=True)
    limite_velocidad_mbps = Column(Integer, nullable=True)
    esta_expirada = Column(Boolean, default=False, nullable=False)

    dispositivo = relationship("Dispositivo", back_populates="sesiones")
    usuario = relationship("Usuario", back_populates="sesiones")


class DominioBloqueado(Base):
    """
    Representa un sitio web bloqueado en el laboratorio mediante DNS estático.
    Tabla en plural: dominios_bloqueados. Campos en singular.
    """
    __tablename__ = "dominios_bloqueados"

    id = Column(Integer, primary_key=True, index=True)
    dominio = Column(String, unique=True, index=True, nullable=False)
    categoria = Column(String, nullable=True)  # Ej. Streaming, Redes sociales, Juegos
    fecha_creacion = Column(DateTime, default=datetime.now, nullable=False)
    esta_activo = Column(Boolean, default=True, nullable=False)
