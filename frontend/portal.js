const API_URL = "http://localhost:8000";

const token = localStorage.getItem("lab_token");
const usuarioStr = localStorage.getItem("lab_usuario");

if (!token) {
    window.location.href = "login.html";
}

const txtNombreUsuario = document.querySelector("#txt-nombre-usuario");
const relojTiempo = document.querySelector("#reloj-tiempo");
const subtextoTiempo = document.querySelector("#subtexto-tiempo");
const bannerAlerta = document.querySelector("#banner-alerta");
const infoEquipo = document.querySelector("#info-equipo");
const infoIp = document.querySelector("#info-ip");
const infoEstado = document.querySelector("#info-estado");
const badgeVelocidad = document.querySelector("#badge-velocidad-portal");
const descVelocidad = document.querySelector("#desc-velocidad");
const listaCategorias = document.querySelector("#lista-categorias-bloqueadas");
const btnLogout = document.querySelector("#btn-logout");

let tiempoRestanteLocal = null;
let intervalId = null;

if (usuarioStr) {
    try {
        const u = JSON.parse(usuarioStr);
        txtNombreUsuario.textContent = u.nombre_completo || u.nombre_usuario;
    } catch (e) {
        txtNombreUsuario.textContent = "Estudiante";
    }
}

btnLogout.addEventListener("click", () => {
    localStorage.clear();
    window.location.href = "login.html";
});

function formatearSegundos(totalSegundos) {
    if (totalSegundos === null || totalSegundos === undefined) return "Ilimitado ∞";
    if (totalSegundos <= 0) return "00:00";

    const horas = Math.floor(totalSegundos / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;
    const pad = (n) => String(n).padStart(2, "0");

    if (horas > 0) {
        return `${pad(horas)}:${pad(minutos)}:${pad(segundos)}`;
    }
    return `${pad(minutos)}:${pad(segundos)}`;
}

async function cargarEstadoPortal() {
    try {
        const respuesta = await fetch(`${API_URL}/portal/mi-estado`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (respuesta.status === 401 || respuesta.status === 403) {
            localStorage.clear();
            window.location.href = "login.html";
            return;
        }

        const data = await respuesta.json();

        // 1. Datos de usuario y equipo
        txtNombreUsuario.textContent = data.usuario.nombre_completo || data.usuario.nombre_usuario;
        infoEquipo.textContent = data.dispositivo.nombre_host || "Equipo de Laboratorio";
        infoIp.textContent = data.dispositivo.direccion_ip || "—";
        infoEstado.textContent = data.dispositivo.estado.toUpperCase();

        // 2. Tiempo restante
        tiempoRestanteLocal = data.tiempo.tiempo_restante_segundos;
        actualizarDisplayReloj(data.tiempo);

        // 3. Velocidad QoS
        if (data.velocidad.limite_mbps) {
            badgeVelocidad.textContent = `⚡ ${data.velocidad.limite_mbps} Mbps`;
            badgeVelocidad.className = "badge badge-qos";
            descVelocidad.textContent = data.velocidad.descripcion;
        } else {
            badgeVelocidad.textContent = "⚡ Velocidad Ilimitada";
            badgeVelocidad.className = "badge badge-unlimited";
            descVelocidad.textContent = "Dispones del ancho de banda completo de la red.";
        }

        // 4. Categorías y dominios bloqueados
        listaCategorias.innerHTML = "";
        if (data.filtrado_web.categorias_restringidas.length === 0) {
            listaCategorias.innerHTML = '<span style="color: var(--color-texto-suave); font-size: 0.8rem;">No hay restricciones activas.</span>';
        } else {
            for (const cat of data.filtrado_web.categorias_restringidas) {
                const span = document.createElement("span");
                span.className = "domain-pill";
                span.textContent = `🚫 ${cat}`;
                listaCategorias.appendChild(span);
            }
        }
    } catch (error) {
        console.error("Error al cargar estado del portal:", error);
    }
}

function actualizarDisplayReloj(tiempoData) {
    if (tiempoData.es_ilimitado || tiempoRestanteLocal === null) {
        relojTiempo.textContent = "Ilimitado ∞";
        relojTiempo.className = "portal-clock-display";
        subtextoTiempo.textContent = "No tienes límite de tiempo para esta sesión.";
        bannerAlerta.style.display = "none";
        return;
    }

    if (tiempoRestanteLocal <= 0 || tiempoData.esta_expirada) {
        relojTiempo.textContent = "00:00";
        relojTiempo.className = "portal-clock-display expired";
        subtextoTiempo.textContent = "Tu tiempo de conexión ha finalizado.";
        bannerAlerta.style.display = "block";
        bannerAlerta.style.background = "rgba(239, 68, 68, 0.2)";
        bannerAlerta.style.color = "#fca5a5";
        bannerAlerta.style.border = "1px solid rgba(239, 68, 68, 0.4)";
        bannerAlerta.innerHTML = "⚠️ Tu tiempo se ha agotado. Por favor, solicita tiempo adicional al administrador del laboratorio.";
        return;
    }

    relojTiempo.textContent = formatearSegundos(tiempoRestanteLocal);
    subtextoTiempo.textContent = `Límite asignado: ${tiempoData.limite_tiempo_minutos} minutos`;

    if (tiempoRestanteLocal <= 180) {
        relojTiempo.className = "portal-clock-display warning";
        bannerAlerta.style.display = "block";
        bannerAlerta.style.background = "rgba(234, 179, 8, 0.2)";
        bannerAlerta.style.color = "#fde047";
        bannerAlerta.style.border = "1px solid rgba(234, 179, 8, 0.4)";
        bannerAlerta.innerHTML = "⏳ ¡Atención! Te quedan menos de 3 minutos de conexión.";
    } else {
        relojTiempo.className = "portal-clock-display";
        bannerAlerta.style.display = "none";
    }
}

// Cronómetro en vivo cada segundo
if (!intervalId) {
    intervalId = setInterval(() => {
        if (tiempoRestanteLocal !== null && tiempoRestanteLocal > 0) {
            tiempoRestanteLocal -= 1;
            relojTiempo.textContent = formatearSegundos(tiempoRestanteLocal);
            if (tiempoRestanteLocal <= 0) {
                relojTiempo.className = "portal-clock-display expired";
                bannerAlerta.style.display = "block";
                bannerAlerta.innerHTML = "⚠️ Tu tiempo se ha agotado. Tu conexión ha sido restringida.";
            } else if (tiempoRestanteLocal <= 180) {
                relojTiempo.className = "portal-clock-display warning";
            }
        }
    }, 1000);
}

// Carga inicial y refresco cada 8 segundos
cargarEstadoPortal();
setInterval(cargarEstadoPortal, 8000);
