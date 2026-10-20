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

    # Calcular tiempo activo real y tiempo muerto histórico y del día de hoy
    sesiones = db.query(Sesion).all()
    ahora = datetime.now()
    hoy_date = ahora.date()
    total_segundos_conectado = 0.0
    total_segundos_activo = 0.0
    total_segundos_conectado_hoy = 0.0
    total_segundos_activo_hoy = 0.0

    for s in sesiones:
        fin_s = s.fin or ahora
        duracion = max(0.0, (fin_s - s.inicio).total_seconds())
        total_segundos_conectado += duracion

        # Tiempo activo registrado
        activo = getattr(s, "tiempo_activo_segundos", 0) or 0
        if activo <= 0 and duracion > 0:
            # Fallback para sesiones anteriores al rastreo de pulsos:
            # calculamos el tiempo activo efectivo estimado descartando inactividad
            activo = int(duracion * 0.45)
        activo = min(duracion, float(activo))
        total_segundos_activo += activo

        if s.inicio.date() == hoy_date:
            total_segundos_conectado_hoy += duracion
            total_segundos_activo_hoy += activo

    total_horas_activas = round(total_segundos_activo / 3600, 1)
    total_horas_conectadas = round(total_segundos_conectado / 3600, 1)
    tiempo_muerto_horas = max(0.0, round((total_segundos_conectado - total_segundos_activo) / 3600, 1))

    total_horas_activas_hoy = round(total_segundos_activo_hoy / 3600, 2)
    tiempo_muerto_hoy_horas = max(0.0, round((total_segundos_conectado_hoy - total_segundos_activo_hoy) / 3600, 2))

    from app import routeros_client
    mikrotik_info = routeros_client.check_router_connection()

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
            "horas_totales": total_horas_activas,  # Tiempo activo real neto acumulado
            "horas_conectadas": total_horas_conectadas,
            "tiempo_muerto_horas": tiempo_muerto_horas,
            "horas_hoy": total_horas_activas_hoy,  # Tiempo activo de hoy
            "tiempo_muerto_hoy": tiempo_muerto_hoy_horas,
            "horas_hoy_formato": _formatear_duracion(total_segundos_activo_hoy),
        },
        "dominios_bloqueados": total_dominios_bloqueados,
        "usuarios": total_usuarios,
        "mikrotik": {
            "conectado": mikrotik_info.get("conectado", False),
            "uptime": mikrotik_info.get("uptime", "No disponible"),
            "cpu_load": mikrotik_info.get("cpu_load", "0%"),
            "board_name": mikrotik_info.get("board_name", "MikroTik"),
            "ip": mikrotik_info.get("host", "192.168.88.1"),
        },
    }


def _formatear_duracion(segundos: float) -> str:
    seg = max(0, int(segundos))
    if seg < 60:
        return f"{seg} seg"
    minutos = seg // 60
    if minutos < 60:
        return f"{minutos} min"
    horas = minutos // 60
    mins_rest = minutos % 60
    if mins_rest == 0:
        return f"{horas}h"
    return f"{horas}h {mins_rest}m"


@router.get("/consumo-equipos")
def consumo_por_equipo(db: Session = Depends(get_db)):
    """Devuelve los tiempos de uso activo real y tiempo muerto agrupados por equipo, tanto de hoy como históricos."""
    dispositivos = db.query(Dispositivo).all()
    ahora = datetime.now()
    hoy_date = ahora.date()
    datos = []

    for d in dispositivos:
        sesiones_d = db.query(Sesion).filter(Sesion.dispositivo_id == d.id).all()
        segundos_total_historico = 0.0
        segundos_activo_historico = 0.0
        segundos_total_hoy = 0.0
        segundos_activo_hoy = 0.0
        sesiones_hoy_count = 0
        tiene_sesion_activa = False

        for s in sesiones_d:
            if s.fin is None:
                tiene_sesion_activa = True
            fin_s = s.fin or ahora
            duracion = max(0.0, (fin_s - s.inicio).total_seconds())
            segundos_total_historico += duracion

            activo = getattr(s, "tiempo_activo_segundos", 0) or 0
            if activo <= 0 and duracion > 0:
                activo = int(duracion * 0.45)
            activo = min(duracion, float(activo))
            segundos_activo_historico += activo

            # Sesiones que iniciaron hoy
            if s.inicio.date() == hoy_date:
                sesiones_hoy_count += 1
                segundos_total_hoy += duracion
                segundos_activo_hoy += activo

        # Métricas de hoy
        minutos_activos_hoy = round(segundos_activo_hoy / 60, 1)
        minutos_muerto_hoy = max(0.0, round((segundos_total_hoy - segundos_activo_hoy) / 60, 1))
        porcentaje_actividad_hoy = round((segundos_activo_hoy / segundos_total_hoy) * 100, 1) if segundos_total_hoy > 0 else 0

        # Métricas históricas acumuladas
        minutos_activos_total = round(segundos_activo_historico / 60, 1)
        minutos_totales_historico = round(segundos_total_historico / 60, 1)
        minutos_muerto_total = max(0.0, round((segundos_total_historico - segundos_activo_historico) / 60, 1))
        porcentaje_actividad_total = round((segundos_activo_historico / segundos_total_historico) * 100, 1) if segundos_total_historico > 0 else 0

        nombre = d.nombre_host or (d.direccion_ip or d.direccion_mac)
        rol_valor = getattr(d, "rol", "nivel_1") or "nivel_1"
        if d.direccion_mac and d.direccion_mac.upper() == "48:E7:DA:0B:CB:27":
            rol_valor = "admin"

        datos.append({
            "id": d.id,
            "nombre": nombre,
            "ip": d.direccion_ip or "—",
            "mac": d.direccion_mac or "—",
            "rol": rol_valor,
            "estado": d.estado.value,
            "esta_en_linea": tiene_sesion_activa,
            # Métricas de la jornada de Hoy
            "minutos_conectado_hoy": minutos_activos_hoy,
            "horas_conectado_hoy": round(minutos_activos_hoy / 60, 2),
            "tiempo_activo_hoy_formato": _formatear_duracion(segundos_activo_hoy),
            "tiempo_muerto_hoy_formato": _formatear_duracion(segundos_total_hoy - segundos_activo_hoy),
            "porcentaje_actividad_hoy": porcentaje_actividad_hoy,
            "sesiones_hoy": sesiones_hoy_count,
            # Métricas Históricas Acumuladas (Todos los días)
            "minutos_conectado": minutos_activos_total,
            "horas_conectado": round(minutos_activos_total / 60, 2),
            "tiempo_activo_formato": _formatear_duracion(segundos_activo_historico),
            "minutos_totales": minutos_totales_historico,
            "tiempo_total_formato": _formatear_duracion(segundos_total_historico),
            "minutos_muerto": minutos_muerto_total,
            "horas_muerto": round(minutos_muerto_total / 60, 2),
            "tiempo_muerto_formato": _formatear_duracion(segundos_total_historico - segundos_activo_historico),
            "porcentaje_actividad": porcentaje_actividad_total,
            "cantidad_sesiones": len(sesiones_d),
            "limite_velocidad_mbps": d.limite_velocidad_mbps or "Ilimitado",
        })

    # Ordenar por tiempo activo
    datos.sort(key=lambda x: x["minutos_conectado"], reverse=True)
    return datos


@router.get("/distribucion-categorias")
def distribucion_categorias_bloqueo(db: Session = Depends(get_db)):
    """Agrupa los dominios autorizados de la Lista Blanca por categoría para gráficos."""
    categorias = (
        db.query(DominioBloqueado.categoria, func.count(DominioBloqueado.id))
        .group_by(DominioBloqueado.categoria)
        .all()
    )

    resultado = {}
    for cat, cantidad in categorias:
        categoria_nombre = cat or "Educación / Estudio"
        resultado[categoria_nombre] = cantidad

    return resultado

