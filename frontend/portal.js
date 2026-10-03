const API_URL = `${window.location.protocol}//${window.location.hostname || "localhost"}:8000`;

// Elementos de las vistas principales
const vistaCargando = document.querySelector("#vista-cargando");
const vistaEspera = document.querySelector("#vista-espera");
const vistaActiva = document.querySelector("#vista-activa");
const vistaExpirada = document.querySelector("#vista-expirada");

// Elementos de la vista de espera
const esperaEquipo = document.querySelector("#espera-equipo");
const esperaIp = document.querySelector("#espera-ip");

// Elementos de la vista activa
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

// Elementos de la vista expirada
const expiradoEquipo = document.querySelector("#expirado-equipo");
const expiradoIp = document.querySelector("#expirado-ip");

let tiempoRestanteLocal = null;
let intervalSegundoId = null;
let pollingIntervalId = null;

// Manejo opcional de usuario si inició sesión con cuenta
const token = localStorage.getItem("lab_token");
const usuarioStr = localStorage.getItem("lab_usuario");

if (usuarioStr && txtNombreUsuario) {
    try {
        const u = JSON.parse(usuarioStr);
        txtNombreUsuario.textContent = u.nombre_completo || u.nombre_usuario;
        if (btnLogout) btnLogout.style.display = "inline-block";
    } catch (e) {
        txtNombreUsuario.textContent = "Estudiante";
    }
}

if (btnLogout) {
    btnLogout.addEventListener("click", () => {
        localStorage.clear();
        window.location.href = "login.html";
    });
}

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

function cambiarVista(vistaDestino) {
    vistaCargando.style.display = "none";
    vistaEspera.style.display = vistaDestino === "espera" ? "block" : "none";
    vistaActiva.style.display = vistaDestino === "activa" ? "block" : "none";
    vistaExpirada.style.display = vistaDestino === "expirada" ? "block" : "none";
}

async function consultarEstadoConexion() {
    try {
        const headers = {};
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const respuesta = await fetch(`${API_URL}/portal/estado-conexion`, { headers });
        if (!respuesta.ok) {
            console.warn("Respuesta no satisfactoria del backend:", respuesta.status);
            return;
        }

        const data = await respuesta.json();

        const badgeRolUsuario = document.querySelector("#badge-rol-usuario");
        const rol = data.rol || "nivel_1";

        // Si no hay cuenta personal logueada, mostrar la identidad del equipo y su nivel de rol
        if (!usuarioStr) {
            if (txtNombreUsuario) {
                txtNombreUsuario.textContent = data.nombre_host || `Estación ${data.ip || ''}`;
            }
            if (badgeRolUsuario) {
                if (rol === "nivel_2") {
                    badgeRolUsuario.textContent = "NIVEL 2";
                    badgeRolUsuario.className = "user-role-badge role-nivel2";
                } else if (rol === "admin") {
                    badgeRolUsuario.textContent = "ADMIN";
                    badgeRolUsuario.className = "user-role-badge role-admin";
                } else {
                    badgeRolUsuario.textContent = "NIVEL 1";
                    badgeRolUsuario.className = "user-role-badge role-nivel1";
                }
            }
        }

        // 1. Estado: PENDIENTE DE APROBACIÓN
        if (data.estado === "pendiente") {
            cambiarVista("espera");
            esperaEquipo.textContent = data.nombre_host || "Estación de Red";
            esperaIp.textContent = data.ip || "—";
            return;
        }

        // 2. Estado: RECHAZADO O EXPIRADO
        if (data.estado === "rechazado" || data.estado === "expirado") {
            cambiarVista("expirada");
            expiradoEquipo.textContent = data.nombre_host || "Estación de Red";
            expiradoIp.textContent = data.ip || "—";
            return;
        }

        // 3. Estado: APROBADO (CONEXIÓN ACTIVA)
        if (data.estado === "aprobado") {
            cambiarVista("activa");

            infoEquipo.textContent = data.nombre_host || "Estación de Red";
            infoIp.textContent = data.ip || "—";
            infoEstado.textContent = "Aprobado";

            // Tiempo y reloj
            if (data.tiempo) {
                tiempoRestanteLocal = data.tiempo.tiempo_restante_segundos;
                actualizarDisplayReloj(data.tiempo);
            }

            // Velocidad QoS
            if (data.velocidad && data.velocidad.limite_mbps) {
                badgeVelocidad.textContent = `⚡ ${data.velocidad.limite_mbps} Mbps`;
                badgeVelocidad.className = "badge badge-qos";
                descVelocidad.textContent = data.velocidad.descripcion;
            } else {
                badgeVelocidad.textContent = "⚡ Velocidad Ilimitada";
                badgeVelocidad.className = "badge badge-unlimited";
                descVelocidad.textContent = "Dispones del ancho de banda completo de la red.";
            }

            // Categorías restringidas
            if (data.filtrado_web && data.filtrado_web.categorias_restringidas) {
                listaCategorias.innerHTML = "";
                if (data.filtrado_web.categorias_restringidas.length === 0) {
                    listaCategorias.innerHTML = '<span style="color: var(--color-texto-suave); font-size: 0.85rem;">No hay restricciones aplicadas.</span>';
                } else {
                    for (const cat of data.filtrado_web.categorias_restringidas) {
                        const span = document.createElement("span");
                        span.className = "domain-pill";
                        span.textContent = `🚫 ${cat}`;
                        listaCategorias.appendChild(span);
                    }
                }
            }

            // Consultar comunicados de red y cargar materiales de laboratorio
            consultarComunicadosActivos(data.ip, data.rol || "nivel_1");
            cargarArchivosPortal(data.rol || "nivel_1");
        }
    } catch (error) {
        console.error("Error al consultar estado de conexión:", error);
    }
}

function actualizarDisplayReloj(tiempoData) {
    if (tiempoData.es_ilimitado || tiempoRestanteLocal === null) {
        relojTiempo.textContent = "Ilimitado ∞";
        relojTiempo.className = "portal-clock-display";
        subtextoTiempo.textContent = "Sesión de conexión abierta sin límite de tiempo.";
        bannerAlerta.style.display = "none";
        return;
    }

    if (tiempoRestanteLocal <= 0 || tiempoData.esta_expirada) {
        relojTiempo.textContent = "00:00";
        relojTiempo.className = "portal-clock-display expired";
        subtextoTiempo.textContent = "Tu tiempo de conexión ha finalizado.";
        cambiarVista("expirada");
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

// Cronómetro local segundo a segundo
if (!intervalSegundoId) {
    intervalSegundoId = setInterval(() => {
        if (tiempoRestanteLocal !== null && tiempoRestanteLocal > 0) {
            tiempoRestanteLocal -= 1;
            relojTiempo.textContent = formatearSegundos(tiempoRestanteLocal);
            if (tiempoRestanteLocal <= 0) {
                cambiarVista("expirada");
            } else if (tiempoRestanteLocal <= 180) {
                relojTiempo.className = "portal-clock-display warning";
                bannerAlerta.style.display = "block";
                bannerAlerta.style.background = "rgba(234, 179, 8, 0.2)";
                bannerAlerta.style.color = "#fde047";
                bannerAlerta.style.border = "1px solid rgba(234, 179, 8, 0.4)";
                bannerAlerta.innerHTML = "⏳ ¡Atención! Te quedan menos de 3 minutos de conexión.";
            }
        }
    }, 1000);
}

// Polling automático cada 4 segundos para detectar la aprobación en vivo
consultarEstadoConexion();
pollingIntervalId = setInterval(consultarEstadoConexion, 4000);

// ============================================================
// ARCHIVOS COMPARTIDOS Y COMUNICADOS EN EL PORTAL
// ============================================================
let comunicadoOcultoId = null;

async function consultarComunicadosActivos(ip, rol) {
    const banner = document.querySelector("#banner-comunicado-red");
    if (!banner) return;

    try {
        const url = `${API_URL}/messages/active?ip=${encodeURIComponent(ip || "")}&rol=${encodeURIComponent(rol || "nivel_1")}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const mensajes = await res.json();

        if (mensajes.length === 0) {
            banner.style.display = "none";
            return;
        }

        const msg = mensajes[0];
        if (comunicadoOcultoId === msg.id) {
            banner.style.display = "none";
            return;
        }

        const tit = document.querySelector("#titulo-comunicado");
        const txt = document.querySelector("#texto-comunicado");
        const ico = document.querySelector("#icono-comunicado");
        const badge = document.querySelector("#badge-tipo-comunicado");

        if (tit) tit.textContent = msg.titulo;
        if (txt) txt.textContent = msg.contenido;

        if (msg.tipo === "aviso") {
            if (ico) ico.textContent = "⚠️";
            if (badge) {
                badge.textContent = "AVISO IMPORTANTE";
                badge.style.background = "rgba(245, 158, 11, 0.2)";
                badge.style.color = "#FBBF24";
            }
            banner.style.borderColor = "rgba(245, 158, 11, 0.4)";
        } else if (msg.tipo === "urgente") {
            if (ico) ico.textContent = "🚨";
            if (badge) {
                badge.textContent = "ALERTA URGENTE";
                badge.style.background = "rgba(239, 68, 68, 0.2)";
                badge.style.color = "#F87171";
            }
            banner.style.borderColor = "rgba(239, 68, 68, 0.45)";
        } else {
            if (ico) ico.textContent = "ℹ️";
            if (badge) {
                badge.textContent = "COMUNICADO";
                badge.style.background = "rgba(0, 229, 255, 0.2)";
                badge.style.color = "#00E5FF";
            }
            banner.style.borderColor = "rgba(0, 229, 255, 0.35)";
        }

        banner.style.display = "block";
    } catch (e) {
        console.error("Error al consultar comunicados:", e);
    }
}

const btnCerrarComunicado = document.querySelector("#btn-cerrar-comunicado");
if (btnCerrarComunicado) {
    btnCerrarComunicado.addEventListener("click", () => {
        const banner = document.querySelector("#banner-comunicado-red");
        if (banner) banner.style.display = "none";
    });
}

function formatearTamanoBytesPortal(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function obtenerIconoArchivoPortal(nombre) {
    const ext = (nombre || "").split(".").pop().toLowerCase();
    if (["pdf"].includes(ext)) return "📄";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "📦";
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "🖼️";
    if (["doc", "docx", "odt"].includes(ext)) return "📝";
    if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
    return "📁";
}

async function cargarArchivosPortal(rol) {
    const lista = document.querySelector("#lista-archivos-portal");
    const contador = document.querySelector("#contador-archivos-portal");
    if (!lista) return;

    try {
        const res = await fetch(`${API_URL}/files/?rol=${encodeURIComponent(rol || "nivel_1")}`);
        if (!res.ok) return;
        const archivos = await res.json();

        if (contador) {
            contador.textContent = `${archivos.length} ${archivos.length === 1 ? "recurso disponible" : "recursos disponibles"}`;
        }

        if (archivos.length === 0) {
            lista.innerHTML = '<span style="color: var(--color-texto-suave); font-size: 0.85rem;">No hay archivos compartidos para esta sesión actualmente.</span>';
            return;
        }

        const fragmento = document.createDocumentFragment();
        archivos.forEach((a) => {
            const item = document.createElement("div");
            item.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--color-borde); padding: 12px 16px; border-radius: 8px; gap: 12px; flex-wrap: wrap;";
            const icono = obtenerIconoArchivoPortal(a.nombre_original);

            item.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-size: 1.5rem;">${icono}</span>
                    <div>
                        <strong style="color: #F1F5F9; font-size: 0.95rem; display: block;">${a.nombre_original}</strong>
                        <span style="color: var(--color-texto-suave); font-size: 0.8rem;">
                            ${a.descripcion ? a.descripcion + " • " : ""}${formatearTamanoBytesPortal(a.tamano_bytes)}
                        </span>
                    </div>
                </div>
                <a href="${API_URL}/files/${a.id}/download" class="btn" style="background: linear-gradient(135deg, #0284C7, #00E5FF); color: #0B0F19; font-weight: 700; padding: 7px 16px; font-size: 0.82rem; text-decoration: none; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 10px rgba(0, 229, 255, 0.2);" target="_blank">
                    ⬇️ Descargar
                </a>
            `;
            fragmento.appendChild(item);
        });

        lista.replaceChildren(fragmento);
    } catch (e) {
        console.error("Error al cargar archivos en el portal:", e);
    }
}

// Botón solicitar reacceso
const btnSolicitarReacceso = document.querySelector("#btn-solicitar-reacceso");
if (btnSolicitarReacceso) {
    btnSolicitarReacceso.addEventListener("click", () => {
        btnSolicitarReacceso.disabled = true;
        btnSolicitarReacceso.innerHTML = "⏳ Solicitando nueva sesión...";
        setTimeout(() => {
            btnSolicitarReacceso.innerHTML = "✅ Solicitud enviada al Administrador";
            consultarEstadoConexion();
            setTimeout(() => {
                btnSolicitarReacceso.disabled = false;
                btnSolicitarReacceso.innerHTML = "✋ Solicitar Acceso / Nueva Sesión";
            }, 5000);
        }, 1000);
    });
}

// Carga periódica
setInterval(() => {
    consultarComunicadosActivos();
}, 8000);

