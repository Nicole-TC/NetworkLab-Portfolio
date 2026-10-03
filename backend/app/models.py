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
    nivel_2 = "nivel_2"  # Supervisión / Docentes / Encargados de Área
    nivel_1 = "nivel_1"  # Estándar / Alumnos / Operativo / Invitados
    alumno = "alumno"    # Alias de compatibilidad


class Usuario(Base):
    """
    Representa un usuario del sistema (Administrador, Nivel 1 o Nivel 2).
    Tabla en plural: usuarios. Campos en singular.
    """
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    nombre_usuario = Column(String, unique=True, index=True, nullable=False)
    clave_hash = Column(String, nullable=False)
    rol = Column(Enum(RolUsuario), default=RolUsuario.nivel_1, nullable=False)
    nombre_completo = Column(String, nullable=True)
    creado_en = Column(DateTime, default=datetime.now, nullable=False)
    esta_activo = Column(Boolean, default=True, nullable=False)

    dispositivos = relationship("Dispositivo", back_populates="usuario")
    sesiones = relationship("Sesion", back_populates="usuario")


class Dispositivo(Base):
    """
    Representa un equipo físico que se conecta a la red.
    Tabla en plural: dispositivos. Campos en singular.
    """
    __tablename__ = "dispositivos"

    id = Column(Integer, primary_key=True, index=True)
    direccion_mac = Column(String, unique=True, index=True, nullable=False)
    direccion_ip = Column(String, nullable=True)
    nombre_host = Column(String, nullable=True)
    estado = Column(Enum(EstadoDispositivo), default=EstadoDispositivo.pendiente, nullable=False)
    rol = Column(String, default="nivel_1", nullable=True)  # 'nivel_1', 'nivel_2', 'admin'
    primera_conexion = Column(DateTime, default=datetime.now)
    ultima_actividad = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    limite_velocidad_mbps = Column(Integer, nullable=True)  # None = Ilimitado
    exento_filtro = Column(Boolean, default=False, nullable=True)
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
    alcance = Column(String, default="todos", nullable=True)  # 'todos', 'todos_excepto', 'solo_seleccionados'
    dispositivos_ids = Column(String, default="", nullable=True)  # IDs separados por coma (ej: "1,2")
    fecha_creacion = Column(DateTime, default=datetime.now, nullable=False)
    esta_activo = Column(Boolean, default=True, nullable=False)


class PoliticaRol(Base):
    """
    Políticas y permisos por defecto para cada rol/nivel del sistema.
    Permite configurar tiempo por defecto, límite de velocidad QoS,
    y si está exento o sujeto al filtro web por defecto.
    """
    __tablename__ = "politicas_roles"

    id = Column(Integer, primary_key=True, index=True)
    rol = Column(String, unique=True, index=True, nullable=False)  # 'nivel_1', 'nivel_2', 'admin'
    nombre_visible = Column(String, nullable=False)
    descripcion = Column(String, nullable=True)
    tiempo_defecto_minutos = Column(Integer, nullable=True)  # None o 0 = Ilimitado
    velocidad_defecto_mbps = Column(Integer, nullable=True)  # None o 0 = Ilimitado
    exento_filtro_defecto = Column(Boolean, default=False, nullable=False)
    permite_reacceso = Column(Boolean, default=True, nullable=False)
    actualizado_en = Column(DateTime, default=datetime.now, onupdate=datetime.now)


class ArchivoCompartido(Base):
    """
    Representa un archivo subido por el profesor/administrador para compartir
    con los puestos del laboratorio (guías prácticas, software, PDFs, etc.).
    """
    __tablename__ = "archivos_compartidos"

    id = Column(Integer, primary_key=True, index=True)
    nombre_archivo = Column(String, nullable=False)
    nombre_original = Column(String, nullable=False)
    descripcion = Column(String, nullable=True)
    tamano_bytes = Column(Integer, nullable=False, default=0)
    tipo_mime = Column(String, nullable=True)
    alcance = Column(String, default="todos", nullable=False)  # 'todos', 'nivel_1', 'nivel_2'
    fecha_subida = Column(DateTime, default=datetime.now, nullable=False)
    subido_por = Column(String, default="admin", nullable=True)


class MensajeRed(Base):
    """
    Mensajes, anuncios y notificaciones enviados desde la consola central
    hacia las estaciones de trabajo del laboratorio.
    """
    __tablename__ = "mensajes_red"

    id = Column(Integer, primary_key=True, index=True)
    titulo = Column(String, nullable=False)
    contenido = Column(String, nullable=False)
    tipo = Column(String, default="info", nullable=False)  # 'info', 'aviso', 'urgente'
    alcance = Column(String, default="todos", nullable=False)  # 'todos', 'nivel_1', 'nivel_2', 'dispositivo'
    dispositivo_id = Column(Integer, nullable=True)
    direccion_ip = Column(String, nullable=True)
    creado_en = Column(DateTime, default=datetime.now, nullable=False)
    activo = Column(Boolean, default=True, nullable=False)
    creado_por = Column(String, default="admin", nullable=True)


