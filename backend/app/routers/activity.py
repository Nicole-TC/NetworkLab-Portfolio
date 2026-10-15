from datetime import datetime, date, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import Dispositivo, Sesion, EstadoDispositivo, RegistroActividadApp, DominioBloqueado
from app import routeros_client
from app.config import settings

router = APIRouter(prefix="/activity", tags=["activity"])


def deducir_tipo_dispositivo(hostname: str | None, mac: str | None) -> str:
    """
    Deduce el tipo de equipo (desktop, notebook, smartphone, tablet)
    usando heurísticas de nombre de host, dirección MAC (OUI) y bit de MAC aleatoria/privada.
    """
    h = (hostname or "").strip().upper()
    m = (mac or "").strip().upper()

    # 1. Deducción por Nombre de Host
    if any(k in h for k in ["DESKTOP-", "PC-", "TORRE", "WORKSTATION", "FIXED", "RIG", "CABINET", "OPTIPLEX", "THINKCENTRE"]):
        return "desktop"
    if any(k in h for k in ["LAPTOP-", "NOTEBOOK", "PORTATIL", "THINKPAD", "MACBOOK", "ZENBOOK", "ENVY", "INSPIRON", "PAVILION", "SURFACE", "IDEAPAD"]):
        return "notebook"
    if any(k in h for k in ["IPHONE", "GALAXY", "REDMI", "XIAOMI", "MOTO", "PIXEL", "HUAWEI", "POCO", "REALME", "SM-", "ONEPLUS", "OPPO", "VIVO", "HONOR", "CELULAR", "PHONE", "MOVIL"]):
        return "smartphone"
    if any(k in h for k in ["IPAD", "TABLET", "TAB", "MEDIA-PAD", "KINDLE"]):
        return "tablet"

    # 2. Detección por Dirección MAC Aleatoria / Privada (IEEE 802 Locally Administered)
    # En Wi-Fi, Android 10+ e iOS 14+ activan por defecto la 'Dirección MAC aleatoria'
    # cuyo 2do dígito hexadecimal del primer octeto siempre es 2, 6, A o E (ej: 16:13:C0:...)
    if m and len(m) >= 2:
        segundo_caracter = m[1]
        if segundo_caracter in ("2", "6", "A", "E") and not any(k in h for k in ["DESKTOP", "LAPTOP", "NOTEBOOK", "PC-"]):
            # Si tiene MAC aleatoria y no es una PC con nombre explícito de Windows, es un teléfono/móvil
            return "smartphone"

    # 3. Deducción por Fabricante MAC (OUI primeros 6 hex)
    if m and len(m) >= 8:
        prefix = m[:8]
        # Fabricantes celulares y tablets
        samsung_ouis = ["00:12:47", "00:15:99", "00:17:C9", "00:23:D7", "08:37:3D", "14:49:E0", "28:BA:B5", "34:23:87", "50:85:69", "78:40:E4", "84:25:DB", "A0:0B:BA", "B4:07:F9", "CC:07:AB"]
        xiaomi_ouis = ["00:9E:C8", "18:59:36", "28:6C:07", "34:80:B3", "50:64:2B", "64:09:80", "78:11:DC", "8C:BE:BE", "A0:86:C6", "C4:0B:CB"]
        apple_ouis = ["00:03:93", "00:05:02", "00:0A:27", "00:17:F2", "00:1E:52", "00:25:00", "04:0C:CE", "08:70:45", "10:93:E9", "14:20:5E", "28:E0:2C", "34:15:9E", "3C:D0:F8", "40:6C:8F", "48:E7:DA", "70:81:EB"]
        motorola_ouis = ["00:0A:28", "00:0C:E5", "00:14:9A", "00:1A:66", "14:30:04", "40:88:05", "54:4E:90", "84:5B:12", "E4:90:7E", "F8:CF:C5"]
        huawei_ouis = ["00:18:82", "00:1E:10", "00:25:68", "04:25:C5", "08:19:A6", "10:47:80", "24:69:A5", "48:46:FB", "70:72:3C", "88:53:D4"]

        if any(prefix.startswith(x) for x in samsung_ouis) or any(prefix.startswith(x) for x in xiaomi_ouis) or any(prefix.startswith(x) for x in motorola_ouis) or any(prefix.startswith(x) for x in huawei_ouis):
            return "smartphone"
        if any(prefix.startswith(x) for x in apple_ouis):
            return "notebook" if ("MAC" in h or "OSX" in h) else "smartphone"

    # 4. Predeterminado según si tiene nombre Windows (DESKTOP) o genérico
    if "DESKTOP" in h:
        return "desktop"
    if "LAPTOP" in h or "NETBOOK" in h:
        return "notebook"

    # Si no tiene nombre de host y se conecta sin prefijos conocidos, en redes Wi-Fi suele ser smartphone
    if not h or h.startswith("ESTACIÓN") or h.startswith("ESTACION"):
        return "smartphone" if (m and len(m) >= 2 and m[1] in ("2", "6", "A", "E")) else "desktop"

    return "desktop"


CATALOGO_APPS = [
    # JUEGOS ONLINE
    {"id": "dota2", "nombre": "Dota 2 / Steam", "categoria": "juegos", "categoria_nombre": "Juegos Online", "icono": "🎮", "color": "#ec4899", "dominio": "steampowered.com", "patrones": ["steampowered", "steamcommunity", "valvesoftware", "dota2", "steam"]},
    {"id": "riot", "nombre": "Riot Games (LoL / Valorant)", "categoria": "juegos", "categoria_nombre": "Juegos Online", "icono": "⚔️", "color": "#f43f5e", "dominio": "riotgames.com", "patrones": ["riotgames", "leagueoflegends", "pvp.net", "riotcdn"]},
    {"id": "epic", "nombre": "Epic Games / Fortnite", "categoria": "juegos", "categoria_nombre": "Juegos Online", "icono": "🕹️", "color": "#fb7185", "dominio": "epicgames.com", "patrones": ["epicgames", "unrealengine", "fortnite"]},
    {"id": "roblox", "nombre": "Roblox", "categoria": "juegos", "categoria_nombre": "Juegos Online", "icono": "🧱", "color": "#e11d48", "dominio": "roblox.com", "patrones": ["roblox", "rbxcdn"]},

    # STREAMING Y VIDEO
    {"id": "youtube", "nombre": "YouTube", "categoria": "streaming", "categoria_nombre": "Streaming y Video", "icono": "▶️", "color": "#ef4444", "dominio": "youtube.com", "patrones": ["youtube", "googlevideo", "ytimg", "youtu.be"]},
    {"id": "twitch", "nombre": "Twitch", "categoria": "streaming", "categoria_nombre": "Streaming y Video", "icono": "🟣", "color": "#9333ea", "dominio": "twitch.tv", "patrones": ["twitch", "ttvnw", "jtvnw"]},
    {"id": "netflix", "nombre": "Netflix", "categoria": "streaming", "categoria_nombre": "Streaming y Video", "icono": "🍿", "color": "#dc2626", "dominio": "netflix.com", "patrones": ["netflix", "nflxvideo", "nflximg"]},
    {"id": "spotify", "nombre": "Spotify", "categoria": "streaming", "categoria_nombre": "Música y Streaming", "icono": "🎧", "color": "#22c55e", "dominio": "spotify.com", "patrones": ["spotify", "scdn.co"]},
    {"id": "tiktok", "nombre": "TikTok", "categoria": "streaming", "categoria_nombre": "Streaming y Video", "icono": "🎵", "color": "#06b6d4", "dominio": "tiktok.com", "patrones": ["tiktok", "byteoversea", "ibyteimg"]},

    # REDES SOCIALES Y MENSAJERÍA
    {"id": "whatsapp", "nombre": "WhatsApp Web", "categoria": "social", "categoria_nombre": "Redes Sociales y Chat", "icono": "💬", "color": "#10b981", "dominio": "web.whatsapp.com", "patrones": ["whatsapp", "wa.me"]},
    {"id": "discord", "nombre": "Discord", "categoria": "social", "categoria_nombre": "Redes Sociales y Chat", "icono": "🎧", "color": "#8b5cf6", "dominio": "discord.com", "patrones": ["discord", "discordapp", "discord.gg"]},
    {"id": "instagram", "nombre": "Instagram", "categoria": "social", "categoria_nombre": "Redes Sociales", "icono": "📸", "color": "#d946ef", "dominio": "instagram.com", "patrones": ["instagram", "cdninstagram"]},
    {"id": "facebook", "nombre": "Facebook", "categoria": "social", "categoria_nombre": "Redes Sociales", "icono": "📘", "color": "#3b82f6", "dominio": "facebook.com", "patrones": ["facebook", "fbcdn", "fbsbx"]},
    {"id": "twitter", "nombre": "X (Twitter)", "categoria": "social", "categoria_nombre": "Redes Sociales", "icono": "🐦", "color": "#64748b", "dominio": "x.com", "patrones": ["twitter", "twimg", "x.com"]},
    {"id": "telegram", "nombre": "Telegram", "categoria": "social", "categoria_nombre": "Mensajería", "icono": "✈️", "color": "#0284c7", "dominio": "telegram.org", "patrones": ["telegram", "t.me"]},

    # ESTUDIO Y PLATAFORMAS EDUCATIVAS
    {"id": "classroom", "nombre": "Google Classroom", "categoria": "estudio", "categoria_nombre": "Plataforma Educativa", "icono": "🏫", "color": "#16a34a", "dominio": "classroom.google.com", "patrones": ["classroom.google"]},
    {"id": "meet", "nombre": "Google Meet", "categoria": "estudio", "categoria_nombre": "Clases y Videollamadas", "icono": "📹", "color": "#0d9488", "dominio": "meet.google.com", "patrones": ["meet.google"]},
    {"id": "drive", "nombre": "Google Drive / Docs", "categoria": "estudio", "categoria_nombre": "Herramientas de Estudio", "icono": "📁", "color": "#f59e0b", "dominio": "drive.google.com", "patrones": ["docs.google", "drive.google"]},
    {"id": "wikipedia", "nombre": "Wikipedia", "categoria": "estudio", "categoria_nombre": "Estudio e Investigación", "icono": "📚", "color": "#10b981", "dominio": "wikipedia.org", "patrones": ["wikipedia", "wikimedia", "wikidata"]},
    {"id": "github", "nombre": "GitHub", "categoria": "estudio", "categoria_nombre": "Desarrollo y Código", "icono": "🐙", "color": "#a855f7", "dominio": "github.com", "patrones": ["github", "githubusercontent", "github.io"]},
    {"id": "stackoverflow", "nombre": "Stack Overflow", "categoria": "estudio", "categoria_nombre": "Programación y Soporte", "icono": "💡", "color": "#f97316", "dominio": "stackoverflow.com", "patrones": ["stackoverflow", "stackexchange"]},
    {"id": "khan", "nombre": "Khan Academy", "categoria": "estudio", "categoria_nombre": "Plataforma Educativa", "icono": "🎓", "color": "#14b8a6", "dominio": "khanacademy.org", "patrones": ["khanacademy"]},
    {"id": "duolingo", "nombre": "Duolingo", "categoria": "estudio", "categoria_nombre": "Idiomas y Estudio", "icono": "🦉", "color": "#84cc16", "dominio": "duolingo.com", "patrones": ["duolingo"]},
    {"id": "moodle", "nombre": "Campus Virtual / Moodle", "categoria": "estudio", "categoria_nombre": "Campus Educativo", "icono": "🎒", "color": "#ea580c", "dominio": "campus.virtual", "patrones": ["moodle", "campus", "virtual", "educ.ar"]},

    # HERRAMIENTAS Y BÚSQUEDA
    {"id": "chatgpt", "nombre": "ChatGPT / OpenAI", "categoria": "herramientas", "categoria_nombre": "Inteligencia Artificial", "icono": "🤖", "color": "#10a37f", "dominio": "chatgpt.com", "patrones": ["chatgpt", "openai", "oaistatic"]},
    {"id": "google", "nombre": "Google Búsqueda", "categoria": "herramientas", "categoria_nombre": "Búsqueda y Navegación", "icono": "🔍", "color": "#4285f4", "dominio": "google.com", "patrones": ["google.com", "google.com.ar", "gstatic"]},
    {"id": "canva", "nombre": "Canva", "categoria": "herramientas", "categoria_nombre": "Diseño y Gráfica", "icono": "🎨", "color": "#06b6d4", "dominio": "canva.com", "patrones": ["canva"]},
    {"id": "mercadolibre", "nombre": "Mercado Libre", "categoria": "general", "categoria_nombre": "Compras y Servicios", "icono": "📦", "color": "#eab308", "dominio": "mercadolibre.com.ar", "patrones": ["mercadolibre", "mercadopago", "mlstatic"]},
]

NOMBRES_CATEGORIAS = {
    "juegos": "Juegos Online",
    "streaming": "Streaming y Video",
    "social": "Redes Sociales y Chat",
    "estudio": "Estudio y Plataformas Educativas",
    "herramientas": "Herramientas y Búsqueda",
    "general": "Navegación Web y Herramientas",
}

COLORES_CATEGORIAS = {
    "juegos": "#ec4899",
    "streaming": "#ef4444",
    "social": "#8b5cf6",
    "estudio": "#10b981",
    "herramientas": "#06b6d4",
    "general": "#0ea5e9",
}

ICONOS_CATEGORIAS = {
    "juegos": "🎮",
    "streaming": "▶️",
    "social": "💬",
    "estudio": "📚",
    "herramientas": "🛠️",
    "general": "🌐",
}


def obtener_info_app(app_nombre: str, categoria: str | None = None) -> dict:
    """Devuelve los metadatos visuales (icono, color, categoría, dominio) para una aplicación o sitio web."""
    for item in CATALOGO_APPS:
        if item["nombre"].lower() == app_nombre.lower():
            return {
                "categoria": item["categoria"],
                "categoria_nombre": item["categoria_nombre"],
                "icono": item["icono"],
                "color": item["color"],
                "dominio": item["dominio"],
            }

    # Si es un dominio genérico detectado dinámicamente
    cat = categoria or "general"
    return {
        "categoria": cat,
        "categoria_nombre": NOMBRES_CATEGORIAS.get(cat, "Navegación Web"),
        "icono": ICONOS_CATEGORIAS.get(cat, "🌐"),
        "color": COLORES_CATEGORIAS.get(cat, "#0ea5e9"),
        "dominio": app_nombre.lower() if "." in app_nombre else "web",
    }


def clasificar_conexion(dst_ip: str, dst_port: int, proto: str, domain_resolved: str) -> dict | None:
    """Clasifica una conexión en tiempo real hacia una aplicación o sitio web específico."""
    dom = (domain_resolved or "").lower()

    # 1. Búsqueda directa por patrones de dominio en el catálogo
    if dom:
        for item in CATALOGO_APPS:
            if any(p in dom for p in item["patrones"]):
                return {
                    "nombre": item["nombre"],
                    "categoria": item["categoria"],
                    "icono": item["icono"],
                    "color": item["color"],
                    "dominio": item["dominio"],
                }

    # 2. Detección por puertos típicos de videojuegos conocidos
    if (proto == "udp" and (27000 <= dst_port <= 27050 or 27015 <= dst_port <= 27030 or dst_port == 4380)) or \
       (proto == "tcp" and 27015 <= dst_port <= 27030):
        return {"nombre": "Dota 2 / Steam", "categoria": "juegos", "icono": "🎮", "color": "#ec4899", "dominio": "steampowered.com"}

    if proto == "udp" and 5000 <= dst_port <= 5500:
        return {"nombre": "Riot Games (LoL/Valorant)", "categoria": "juegos", "icono": "⚔️", "color": "#f43f5e", "dominio": "riotgames.com"}

    # 3. Detección por puertos de VoIP / Chat
    if (proto == "udp" and 50000 <= dst_port <= 65535):
        return {"nombre": "Discord", "categoria": "social", "icono": "🎧", "color": "#8b5cf6", "dominio": "discord.com"}

    # Notificaciones push y servicios en segundo plano de Google (FCM/mtalk en puertos 5228-5230)
    if dst_port in (5228, 5229, 5230):
        return {"nombre": "Google Play Services", "categoria": "herramientas", "icono": "⚙️", "color": "#4285f4", "dominio": "mtalk.google.com"}

    # Tráfico de mensajería XMPP nativo solo si coincide con dominio de chat
    if dst_port in (5222, 4244) and any(w in dom for w in ["whatsapp", "chat", "xmpp"]):
        return {"nombre": "WhatsApp Web", "categoria": "social", "icono": "💬", "color": "#10b981", "dominio": "web.whatsapp.com"}

    # 4. Si hay dominio limpio en DNS (ej. 'infobae.com', 'wikipedia.org', 'frba.utn.edu.ar')
    if dom and "." in dom and not dom.endswith(".local") and not dom.endswith(".arpa") and not dom.endswith(".lan"):
        clean_dom = dom.replace("www.", "")
        # Extraer nombre legible
        partes = clean_dom.split(".")
        nombre_sitio = partes[0].capitalize() if len(partes) > 1 else clean_dom.capitalize()
        es_edu = any(k in clean_dom for k in ["edu", "edu.ar", "org", "gob", "gob.ar", "uni"])
        cat = "estudio" if es_edu else "general"
        ico = "📚" if es_edu else "🌐"
        col = "#10b981" if es_edu else "#0ea5e9"
        return {"nombre": nombre_sitio, "categoria": cat, "icono": ico, "color": col, "dominio": clean_dom}

    # 5. Conexión web genérica HTTP / HTTPS
    if dst_port in (80, 443, 8080):
        return {"nombre": "Navegación Web", "categoria": "general", "icono": "🌐", "color": "#0ea5e9", "dominio": "web"}

    return None


def analizar_trafico_mikrotik_ip(ip: str) -> dict:
    """
    Inspecciona la tabla de conexiones en tiempo real de MikroTik Y la caché DNS del router
    para una IP, identificando exactamente los sitios web y aplicaciones en uso.
    """
    if not ip or ip in ("127.0.0.1", "localhost", "::1"):
        return {"actividad": "Inactivo", "categoria": "general", "apps": [], "apps_detalle": [], "bytes_in": 0, "bytes_out": 0}

    conexiones = []
    dns_map = {}

    try:
        api = routeros_client.get_connection()

        # 1. Leer caché DNS activa de MikroTik para asociar IPs con nombres de dominios
        try:
            dns_cache = api.path("ip", "dns", "cache")
            for entry in dns_cache:
                d_name = entry.get("name")
                d_data = entry.get("data") or entry.get("address")
                if d_name and d_data:
                    dns_map[str(d_data).strip()] = str(d_name).strip().lower()
        except Exception:
            pass

        # 2. Filtrar conexiones donde la IP es origen o destino
        conn_path = api.path("ip", "firewall", "connection")
        for c in conn_path:
            src = c.get("src-address", "")
            dst = c.get("dst-address", "")
            if ip in src or ip in dst:
                conexiones.append(c)

        api.close()
    except Exception as e:
        conexiones = []

    apps_detectadas_map = {}
    total_bytes = 0

    for c in conexiones:
        proto = (c.get("protocol") or "").lower()
        dst_addr = c.get("dst-address") or ""
        dst_ip = dst_addr.split(":")[0] if ":" in dst_addr else dst_addr
        dst_port = 0
        if ":" in dst_addr:
            try:
                dst_port = int(dst_addr.split(":")[-1])
            except Exception:
                dst_port = 0

        c_bytes = int(c.get("orig-bytes", 0) or 0) + int(c.get("repl-bytes", 0) or 0)
        total_bytes += c_bytes

        domain_res = dns_map.get(dst_ip, "")
        app_info = clasificar_conexion(dst_ip, dst_port, proto, domain_res)

        if app_info:
            nom = app_info["nombre"]
            if nom not in apps_detectadas_map:
                apps_detectadas_map[nom] = {
                    "nombre": nom,
                    "categoria": app_info["categoria"],
                    "categoria_nombre": NOMBRES_CATEGORIAS.get(app_info["categoria"], "Navegación Web"),
                    "icono": app_info["icono"],
                    "color": app_info["color"],
                    "dominio": app_info["dominio"],
                    "bytes": 0,
                    "conexiones": 0,
                }
            apps_detectadas_map[nom]["bytes"] += c_bytes
            apps_detectadas_map[nom]["conexiones"] += 1

    # Ordenar aplicaciones detectadas por bytes transferidos
    apps_ordenadas = sorted(apps_detectadas_map.values(), key=lambda x: x["bytes"], reverse=True)
    lista_nombres_apps = [a["nombre"] for a in apps_ordenadas] or ["Navegación Web"]

    # Determinar actividad principal
    if apps_ordenadas:
        app_top = apps_ordenadas[0]
        actividad = f"{app_top['icono']} {app_top['nombre']}"
        categoria = app_top["categoria"]
    elif len(conexiones) > 0:
        actividad = "🌐 Navegación Web General"
        categoria = "general"
    else:
        actividad = "💤 Inactivo / En Reposo"
        categoria = "general"

    return {
        "actividad": actividad,
        "categoria": categoria,
        "apps": lista_nombres_apps,
        "apps_detalle": apps_ordenadas,
        "conexiones_activas": len(conexiones),
        "total_bytes": total_bytes,
    }


def registrar_pulso_actividad(db: Session, dispositivo_id: int, categoria: str, app_nombre: str, segundos: int, b_in: int, b_out: int):
    """
    Acumula de forma persistente los minutos y bytes consumidos por un equipo
    en una aplicación o sitio web específico para el día de hoy.
    """
    hoy = datetime.now().date()
    registro = (
        db.query(RegistroActividadApp)
        .filter(
            RegistroActividadApp.dispositivo_id == dispositivo_id,
            RegistroActividadApp.fecha == hoy,
            RegistroActividadApp.aplicacion == app_nombre,
        )
        .first()
    )

    if not registro:
        registro = RegistroActividadApp(
            dispositivo_id=dispositivo_id,
            fecha=hoy,
            categoria=categoria,
            aplicacion=app_nombre,
            segundos_activos=segundos,
            bytes_in=b_in,
            bytes_out=b_out,
            ultima_actualizacion=datetime.now(),
        )
        db.add(registro)
    else:
        registro.segundos_activos += segundos
        registro.bytes_in += b_in
        registro.bytes_out += b_out
        registro.ultima_actualizacion = datetime.now()
    db.commit()


@router.get("/devices")
def list_activity_devices(db: Session = Depends(get_db)):
    """
    Lista todos los dispositivos aprobados y activos en la red con su tipo de hardware
    deducido, actividad actual en vivo y resumen dinámico de aplicaciones de hoy.
    """
    dispositivos = (
        db.query(Dispositivo)
        .filter(Dispositivo.estado == EstadoDispositivo.aprobado)
        .order_by(Dispositivo.ultima_actividad.desc())
        .all()
    )

    admin_macs = settings.admin_mac_list
    hoy = datetime.now().date()
    resultado = []

    for d in dispositivos:
        mac_norm = (d.direccion_mac or "").strip().upper()
        es_admin = mac_norm in admin_macs or d.rol == "admin"
        tipo_disp = deducir_tipo_dispositivo(d.nombre_host, d.direccion_mac)

        # Analizar tráfico MikroTik en vivo
        trafico_vivo = analizar_trafico_mikrotik_ip(d.direccion_ip)

        # Totalizar minutos y bytes registrados hoy en la base de datos
        registros_hoy = (
            db.query(RegistroActividadApp)
            .filter(RegistroActividadApp.dispositivo_id == d.id, RegistroActividadApp.fecha == hoy)
            .all()
        )
        segundos_hoy = sum(r.segundos_activos for r in registros_hoy)
        bytes_in_hoy = sum(r.bytes_in for r in registros_hoy)
        bytes_out_hoy = sum(r.bytes_out for r in registros_hoy)

        # Si el equipo está conectado ahora con sesión abierta, sumar el tiempo de la sesión actual
        sesion_abierta = next((s for s in d.sesiones if s.fin is None), None)
        if sesion_abierta and segundos_hoy == 0:
            segundos_hoy = sesion_abierta.tiempo_activo_segundos or int((datetime.now() - sesion_abierta.inicio).total_seconds())

        # Si el equipo está con tráfico vivo, registrar pulsos para cada app detectada
        esta_conectado_reciente = bool(d.ultima_actividad and (datetime.now() - d.ultima_actividad).total_seconds() < 90)
        if esta_conectado_reciente and trafico_vivo.get("apps_detalle"):
            for app_det in trafico_vivo["apps_detalle"]:
                b_in = int(app_det["bytes"] * 0.85)
                b_out = int(app_det["bytes"] * 0.15)
                registrar_pulso_actividad(db, d.id, app_det["categoria"], app_det["nombre"], 60, b_in, b_out)

        minutos_hoy = max(1 if sesion_abierta else 0, round(segundos_hoy / 60))
        total_mb = round((bytes_in_hoy + bytes_out_hoy) / (1024 * 1024), 1)

        resultado.append({
            "id": d.id,
            "nombre_host": d.nombre_host or ("Consola Administrador" if es_admin else f"Estación {d.direccion_ip}"),
            "direccion_ip": d.direccion_ip or "—",
            "direccion_mac": d.direccion_mac or "—",
            "rol": d.rol or "nivel_1",
            "es_admin": es_admin,
            "tipo_dispositivo": tipo_disp,
            "en_linea": bool(sesion_abierta is not None or esta_conectado_reciente),
            "actividad_actual": trafico_vivo["actividad"],
            "categoria_actual": trafico_vivo["categoria"],
            "apps_activas": trafico_vivo["apps"],
            "minutos_hoy": minutos_hoy,
            "trafico_mb_hoy": total_mb,
            "limite_velocidad_mbps": d.limite_velocidad_mbps,
        })

    return resultado


@router.get("/device/{device_id}")
def get_device_activity_detail(
    device_id: int,
    periodo: str = Query("hoy", enum=["hoy", "semana", "historico"]),
    db: Session = Depends(get_db)
):
    """
    Devuelve la radiografía completa y dinámica de aplicaciones reales y sitios web utilizados por el equipo,
    filtrado por: 'hoy', 'semana' (últimos 7 días) o 'historico' (acumulado total).
    """
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    hoy = datetime.now().date()
    query = db.query(RegistroActividadApp).filter(RegistroActividadApp.dispositivo_id == device_id)

    if periodo == "hoy":
        query = query.filter(RegistroActividadApp.fecha == hoy)
    elif periodo == "semana":
        fecha_inicio = hoy - timedelta(days=7)
        query = query.filter(RegistroActividadApp.fecha >= fecha_inicio)

    registros = query.all()

    # Inspeccionar tráfico en vivo del MikroTik
    trafico_vivo = analizar_trafico_mikrotik_ip(device.direccion_ip)
    sesion_activa = next((s for s in device.sesiones if s.fin is None), None)

    # Si hay tráfico en vivo o sesión abierta, registrar de inmediato las aplicaciones activas
    if trafico_vivo.get("apps_detalle") and (sesion_activa or periodo == "hoy"):
        for app_det in trafico_vivo["apps_detalle"]:
            b_in = int(app_det["bytes"] * 0.85)
            b_out = int(app_det["bytes"] * 0.15)
            registrar_pulso_actividad(db, device_id, app_det["categoria"], app_det["nombre"], 60, b_in, b_out)
        registros = query.all()

    # Si aún no tiene registros pero tiene sesión abierta, crear registro representativo inicial
    if not registros and sesion_activa and periodo == "hoy":
        segundos_sesion = sesion_activa.tiempo_activo_segundos or int((datetime.now() - sesion_activa.inicio).total_seconds())
        cat_ini = trafico_vivo["categoria"]
        app_ini = trafico_vivo["apps"][0] if trafico_vivo["apps"] else "Navegación Web"
        registrar_pulso_actividad(db, device_id, cat_ini, app_ini, max(60, segundos_sesion), 8 * 1024 * 1024, 1 * 1024 * 1024)
        registros = query.all()

    # 1. Agrupar dinámicamente por APLICACIÓN / SITIO WEB REAL
    apps_agrupadas = {}
    total_segundos = 0
    total_in = 0
    total_out = 0

    for r in registros:
        app_nom = r.aplicacion
        if app_nom not in apps_agrupadas:
            meta = obtener_info_app(app_nom, r.categoria)
            apps_agrupadas[app_nom] = {
                "nombre": app_nom,
                "categoria": r.categoria,
                "categoria_nombre": meta["categoria_nombre"],
                "icono": meta["icono"],
                "color": meta["color"],
                "dominio": meta["dominio"],
                "segundos": 0,
                "bytes_in": 0,
                "bytes_out": 0,
                "esta_activa": False,
            }

        apps_agrupadas[app_nom]["segundos"] += r.segundos_activos
        apps_agrupadas[app_nom]["bytes_in"] += r.bytes_in
        apps_agrupadas[app_nom]["bytes_out"] += r.bytes_out

        total_segundos += r.segundos_activos
        total_in += r.bytes_in
        total_out += r.bytes_out

    # Marcar aplicaciones que están activas en tiempo real ahora mismo
    nombres_vivos = set(trafico_vivo.get("apps", []))
    for nom_app in apps_agrupadas:
        if nom_app in nombres_vivos or any(nom_app.lower() in v.lower() for v in nombres_vivos):
            apps_agrupadas[nom_app]["esta_activa"] = True

    # 2. Construir lista detallada de aplicaciones ordenadas por tiempo y tráfico
    lista_aplicaciones = []
    for k, v in apps_agrupadas.items():
        mins = round(v["segundos"] / 60)
        pct = round((v["segundos"] / total_segundos * 100), 1) if total_segundos > 0 else 0
        mb_in = round(v["bytes_in"] / (1024 * 1024), 2)
        mb_out = round(v["bytes_out"] / (1024 * 1024), 2)

        lista_aplicaciones.append({
            "nombre": v["nombre"],
            "categoria": v["categoria"],
            "categoria_nombre": v["categoria_nombre"],
            "icono": v["icono"],
            "color": v["color"],
            "dominio": v["dominio"],
            "segundos": v["segundos"],
            "minutos": mins,
            "horas": round(mins / 60, 1),
            "porcentaje": pct,
            "descarga_mb": mb_in,
            "subida_mb": mb_out,
            "esta_activa": v["esta_activa"],
        })

    # Ordenar aplicaciones de mayor a menor tiempo/tráfico
    lista_aplicaciones.sort(key=lambda x: (x["minutos"], x["descarga_mb"]), reverse=True)

    # 3. Construir lista dinámica de categorías (SOLO las que tienen actividad > 0)
    cats_agrupadas = {}
    for app in lista_aplicaciones:
        c_key = app["categoria"]
        if c_key not in cats_agrupadas:
            cats_agrupadas[c_key] = {
                "categoria": c_key,
                "nombre": NOMBRES_CATEGORIAS.get(c_key, "Navegación General"),
                "icono": ICONOS_CATEGORIAS.get(c_key, "🌐"),
                "color": COLORES_CATEGORIAS.get(c_key, "#0ea5e9"),
                "minutos": 0,
                "descarga_mb": 0.0,
                "subida_mb": 0.0,
                "apps_detectadas": [],
            }
        cats_agrupadas[c_key]["minutos"] += app["minutos"]
        cats_agrupadas[c_key]["descarga_mb"] = round(cats_agrupadas[c_key]["descarga_mb"] + app["descarga_mb"], 2)
        cats_agrupadas[c_key]["subida_mb"] = round(cats_agrupadas[c_key]["subida_mb"] + app["subida_mb"], 2)
        cats_agrupadas[c_key]["apps_detectadas"].append(app["nombre"])

    lista_categorias = []
    for c_key, c_val in cats_agrupadas.items():
        pct_c = round((c_val["minutos"] / max(1, round(total_segundos / 60)) * 100), 1) if total_segundos > 0 else 0
        lista_categorias.append({
            "categoria": c_key,
            "nombre": c_val["nombre"],
            "icono": c_val["icono"],
            "color": c_val["color"],
            "minutos": c_val["minutos"],
            "horas": round(c_val["minutos"] / 60, 1),
            "porcentaje": pct_c,
            "descarga_mb": c_val["descarga_mb"],
            "subida_mb": c_val["subida_mb"],
            "apps_detectadas": c_val["apps_detectadas"],
        })
    lista_categorias.sort(key=lambda x: x["minutos"], reverse=True)

    # 4. Datos del gráfico Dona (Top Aplicaciones y Sitios Web)
    labels_grafico = []
    valores_grafico = []
    colores_grafico = []

    for a in lista_aplicaciones[:6]:
        labels_grafico.append(a["nombre"])
        valores_grafico.append(max(1, a["minutos"]))
        colores_grafico.append(a["color"])

    if not valores_grafico:
        labels_grafico = ["En Espera de Actividad"]
        valores_grafico = [1]
        colores_grafico = ["#0ea5e9"]

    tipo_disp = deducir_tipo_dispositivo(device.nombre_host, device.direccion_mac)

    return {
        "dispositivo": {
            "id": device.id,
            "nombre_host": device.nombre_host or f"Estación {device.direccion_ip}",
            "direccion_ip": device.direccion_ip,
            "direccion_mac": device.direccion_mac,
            "rol": device.rol or "nivel_1",
            "tipo_dispositivo": tipo_disp,
            "en_linea": bool(sesion_activa is not None or (device.ultima_actividad and (datetime.now() - device.ultima_actividad).total_seconds() < 90)),
        },
        "periodo": periodo,
        "actividad_actual": trafico_vivo["actividad"],
        "tiempo_total_minutos": max(1 if sesion_activa else 0, round(total_segundos / 60)),
        "tiempo_total_horas": round(total_segundos / 3600, 1),
        "total_descarga_mb": round(total_in / (1024 * 1024), 2),
        "total_subida_mb": round(total_out / (1024 * 1024), 2),
        "total_aplicaciones": len(lista_aplicaciones),
        "aplicaciones": lista_aplicaciones,
        "categorias": lista_categorias,
        "grafico": {
            "labels": labels_grafico,
            "data": valores_grafico,
            "colors": colores_grafico,
        }
    }
