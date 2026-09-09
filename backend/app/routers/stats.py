from datetime import datetime, timedelta
from typing import Dict, List
from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Dispositivo, Sesion, DominioBloqueado, Usuario, EstadoDispositivo

router = APIRouter(prefix="/stats", tags=["estadisticas"])


@router.get("/resumen")
def obtener_resumen_estadisticas(db: Session = Depends(get_db)):
    """Métricas clave para las tarjetas del Dashboard de Administración."""
    total_dispositivos = db.query(Dispositivo).count()
    aprobados = db.query(Dispositivo).filter(Dispositivo.estado == EstadoDispositivo.aprobado).count()
    pendientes = db.query(Dispositivo).filter(Dispositivo.estado == EstadoDispositivo.pendiente).count()
    rechazados = db.query(Dispositivo).filter(Dispositivo.estado == EstadoDispositivo.rechazado).count()

    sesiones_activas = db.query(Sesion).filter(Sesion.fin.is_(None)).count()
    total_sesiones = db.query(Sesion).count()
    total_dominios_bloqueados = db.query(DominioBloqueado).filter(DominioBloqueado.esta_activo == True).count()
    total_usuarios = db.query(Usuario).count()

    # Calcular tiempo total consumido histórico en minutos
    sesiones = db.query(Sesion).all()
    ahora = datetime.now()
    total_segundos = 0.0
    for s in sesiones:
        fin_s = s.fin or ahora
        total_segundos += (fin_s - s.inicio).total_seconds()

    total_horas = round(total_segundos / 3600, 1)

    return {
        "dispositivos": {
            "total": total_dispositivos,
            "aprobados": aprobados,
            "pendientes": pendientes,
            "rechazados": rechazados,
        },
        "sesiones": {
            "activas": sesiones_activas,
            "historicas": total_sesiones,
            "horas_totales": total_horas,
        },
        "dominios_bloqueados": total_dominios_bloqueados,
        "usuarios": total_usuarios,
    }


@router.get("/consumo-equipos")
def consumo_por_equipo(db: Session = Depends(get_db)):
    """Devuelve los tiempos de conexión acumulados agrupados por equipo para gráficos de barras."""
    dispositivos = db.query(Dispositivo).all()
    ahora = datetime.now()
    datos = []

    for d in dispositivos:
        sesiones_d = db.query(Sesion).filter(Sesion.dispositivo_id == d.id).all()
        segundos = 0.0
        for s in sesiones_d:
            fin_s = s.fin or ahora
            segundos += (fin_s - s.inicio).total_seconds()
        
        minutos = round(segundos / 60, 1)
        nombre = d.nombre_host or (d.direccion_ip or d.direccion_mac)
        datos.append({
            "id": d.id,
            "nombre": nombre,
            "ip": d.direccion_ip or "—",
            "mac": d.direccion_mac,
            "minutos_conectado": minutos,
            "horas_conectado": round(minutos / 60, 2),
            "cantidad_sesiones": len(sesiones_d),
            "limite_velocidad_mbps": d.limite_velocidad_mbps or "Ilimitado",
        })

    # Ordenar de mayor a menor consumo
    datos.sort(key=lambda x: x["minutos_conectado"], reverse=True)
    return datos


@router.get("/distribucion-categorias")
def distribucion_categorias_bloqueo(db: Session = Depends(get_db)):
    """Agrupa los dominios bloqueados por categoría para gráficos de dona/torta."""
    categorias = (
        db.query(DominioBloqueado.categoria, func.count(DominioBloqueado.id))
        .group_by(DominioBloqueado.categoria)
        .all()
    )

    resultado = {}
    for cat, cantidad in categorias:
        categoria_nombre = cat or "General"
        resultado[categoria_nombre] = cantidad

    return resultado
