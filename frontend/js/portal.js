const API_URL = `${window.location.protocol}//${window.location.hostname || "localhost"}:8000`;

// Parámetros de URL para identificar IP o MAC si MikroTik los pasó en la redirección
const urlParams = new URLSearchParams(window.location.search);
let queryIp = urlParams.get("ip") || urlParams.get("client_ip") || urlParams.get("user_ip") || "";
let queryMac = urlParams.get("mac") || urlParams.get("client_mac") || "";

// Filtro de validez para evitar guardar IPs de loopback, Docker bridge o puerta de enlace MikroTik
function esIpValidaCliente(ip) {
    if (!ip || typeof ip !== "string") return false;
    const ipTrim = ip.trim();
    if (!ipTrim) return false;
    if (["127.0.0.1", "localhost", "::1", "192.168.88.1", "192.168.88.252"].includes(ipTrim)) return false;
    if (ipTrim.startsWith("172.")) return false;
    return true;
}

// Persistir IP y MAC en sessionStorage / localStorage para que no se pierdan al navegar, refrescar o pasar a Chrome
if (esIpValidaCliente(queryIp)) {
    try {
        sessionStorage.setItem("lab_portal_client_ip", queryIp.trim());
        localStorage.setItem("lab_portal_client_ip", queryIp.trim());
    } catch (_) {}
} else {
    try {
        const guardadaIp = sessionStorage.getItem("lab_portal_client_ip") || localStorage.getItem("lab_portal_client_ip") || "";
        if (esIpValidaCliente(guardadaIp)) {
            queryIp = guardadaIp;
        }
    } catch (_) {}
}

if (queryMac && queryMac.trim() && !queryMac.toUpperCase().includes("48:E7:DA:0B:CB:27")) {
    try {
        sessionStorage.setItem("lab_portal_client_mac", queryMac.trim().toUpperCase());
        localStorage.setItem("lab_portal_client_mac", queryMac.trim().toUpperCase());
    } catch (_) {}
} else {
    try {
        const guardadaMac = sessionStorage.getItem("lab_portal_client_mac") || localStorage.getItem("lab_portal_client_mac") || "";
        if (guardadaMac) {
            queryMac = guardadaMac;
        }
    } catch (_) {}
}

let audioCtxPortal = null;

function escapeHtml(str) {
    if (!str && str !== 0) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

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

// Variables de estado
let tiempoRestanteLocal = null;
let intervalSegundoId = null;
let pollingIntervalId = null;
let estadoAnterior = null;
let ultimoMensajeIdVisto = null;
let clienteIpDetectada = queryIp;
let clienteMacDetectada = queryMac || "";
let clienteNombreDetectado = "";
let clienteRolDetectado = "nivel_1";

// Desbloquear AudioContext en el primer gesto del usuario
document.addEventListener("click", () => {
    if (audioCtxPortal && audioCtxPortal.state === "suspended") {
        audioCtxPortal.resume().catch(() => {});
    }
}, { once: true });
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

// ============================================================
// CONFIGURACIÓN DE APERTURA EN CHROME / NAVEGADOR EXTERNO (HANDOFF)
// ============================================================
function configurarBotonesIntentChrome() {
    const host = window.location.host;
    const params = new URLSearchParams(window.location.search);
    const ipParaUrl = queryIp || (esIpValidaCliente(clienteIpDetectada) ? clienteIpDetectada : "");
    const macParaUrl = queryMac || clienteMacDetectada || "";

    if (ipParaUrl && !params.get("ip")) params.set("ip", ipParaUrl);
    if (macParaUrl && !params.get("mac")) params.set("mac", macParaUrl);

    const search = params.toString() ? `?${params.toString()}` : "";
    const portalUrl = `${window.location.protocol}//${host}/portal.html${search}`;
    const intentUrl = `intent://${host}/portal.html${search}#Intent;scheme=http;package=com.android.chrome;end`;

    const btnIntentEspera = document.querySelector("#btn-intent-espera");
    const btnIntentActivo = document.querySelector("#btn-intent-activo");
    const btnIntentAprobado = document.querySelector("#btn-aprobado-chrome-intent");

    [btnIntentEspera, btnIntentActivo, btnIntentAprobado].forEach((btn) => {
        if (btn) {
            btn.href = intentUrl;
            btn.addEventListener("click", (e) => {
                if (!navigator.userAgent.toLowerCase().includes("android")) {
                    e.preventDefault();
                    window.open(portalUrl, "_blank");
                }
            });
        }
    });

    const btnCopiar = document.querySelector("#btn-copiar-enlace-espera");
    if (btnCopiar) {
        btnCopiar.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(portalUrl);
                btnCopiar.textContent = "✅ ¡Copiado!";
                setTimeout(() => { btnCopiar.textContent = "📋 Copiar Enlace"; }, 2500);
            } catch (err) {
                prompt("Copia este enlace para abrirlo en Chrome:", portalUrl);
            }
        });
    }

    // Control de ocultamiento persistente del banner en celular
    const bannerActivo = document.querySelector("#banner-celular-activo");
    const btnCerrarBanner = document.querySelector("#btn-cerrar-banner-celular");

    if (bannerActivo) {
        if (localStorage.getItem("portal_banner_navegador_oculto") === "true") {
            bannerActivo.style.display = "none";
        }
        if (btnCerrarBanner) {
            btnCerrarBanner.addEventListener("click", () => {
                localStorage.setItem("portal_banner_navegador_oculto", "true");
                bannerActivo.style.display = "none";
            });
        }
        if (btnIntentActivo) {
            btnIntentActivo.addEventListener("click", () => {
                localStorage.setItem("portal_banner_navegador_oculto", "true");
                setTimeout(() => { bannerActivo.style.display = "none"; }, 300);
            });
        }
    }

    const modalAprobado = document.querySelector("#modal-aprobado-chrome");
    const btnAprobadoContinuar = document.querySelector("#btn-aprobado-continuar");
    if (btnAprobadoContinuar && modalAprobado) {
        btnAprobadoContinuar.addEventListener("click", () => {
            modalAprobado.classList.remove("active");
        });
    }
}

// ============================================================
// SISTEMA DE AUDIO NATIVO Y NOTIFICACIONES WEB CON SONIDO
// ============================================================
function reproducirSonidoPortal(tipo = "comunicado") {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!audioCtxPortal) {
            audioCtxPortal = new AudioContextClass();
        }
        if (audioCtxPortal.state === "suspended") {
            audioCtxPortal.resume();
        }

        const now = audioCtxPortal.currentTime;

        if (tipo === "aprobado") {
            // Fanfarria breve de aprobación (Do5 -> Mi5 -> Sol5 -> Do6)
            const notas = [523.25, 659.25, 783.99, 1046.50];
            notas.forEach((freq, idx) => {
                const osc = audioCtxPortal.createOscillator();
                const gain = audioCtxPortal.createGain();
                const t = now + idx * 0.10;
                osc.type = "sine";
                osc.frequency.setValueAtTime(freq, t);
                gain.gain.setValueAtTime(0.001, t);
                gain.gain.linearRampToValueAtTime(0.20, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
                osc.connect(gain);
                gain.connect(audioCtxPortal.destination);
                osc.start(t);
                osc.stop(t + 0.30);
            });
        } else if (tipo === "mensaje_chat") {
            // Chime de mensaje recibido de doble campana armónico (587.33 Hz D5 -> 880 Hz A5)
            const osc1 = audioCtxPortal.createOscillator();
            const gain1 = audioCtxPortal.createGain();
            osc1.type = "sine";
            osc1.frequency.setValueAtTime(587.33, now);
            gain1.gain.setValueAtTime(0.001, now);
            gain1.gain.linearRampToValueAtTime(0.24, now + 0.02);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
            osc1.connect(gain1);
            gain1.connect(audioCtxPortal.destination);
            osc1.start(now);
            osc1.stop(now + 0.24);

            const osc2 = audioCtxPortal.createOscillator();
            const gain2 = audioCtxPortal.createGain();
            osc2.type = "sine";
            osc2.frequency.setValueAtTime(880.00, now + 0.10);
            gain2.gain.setValueAtTime(0.001, now + 0.10);
            gain2.gain.linearRampToValueAtTime(0.28, now + 0.12);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.40);
            osc2.connect(gain2);
            gain2.connect(audioCtxPortal.destination);
            osc2.start(now + 0.10);
            osc2.stop(now + 0.42);
        } else if (tipo === "mensaje_enviado") {
            // Tono suave de envío confirmado (783.99 Hz G5 -> 1046.50 Hz C6)
            const osc = audioCtxPortal.createOscillator();
            const gain = audioCtxPortal.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(783.99, now);
            osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.09);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
            osc.connect(gain);
            gain.connect(audioCtxPortal.destination);
            osc.start(now);
            osc.stop(now + 0.13);
        } else {
            // Chime de anuncio de red (Mi5 659.25 Hz -> Si5 987.77 Hz)
            const osc1 = audioCtxPortal.createOscillator();
            const gain1 = audioCtxPortal.createGain();
            osc1.type = "sine";
            osc1.frequency.setValueAtTime(659.25, now);
            gain1.gain.setValueAtTime(0.001, now);
            gain1.gain.linearRampToValueAtTime(0.22, now + 0.02);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc1.connect(gain1);
            gain1.connect(audioCtxPortal.destination);
            osc1.start(now);
            osc1.stop(now + 0.26);

            const osc2 = audioCtxPortal.createOscillator();
            const gain2 = audioCtxPortal.createGain();
            osc2.type = "triangle";
            osc2.frequency.setValueAtTime(987.77, now + 0.12);
            gain2.gain.setValueAtTime(0.001, now + 0.12);
            gain2.gain.linearRampToValueAtTime(0.18, now + 0.14);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.50);
            osc2.connect(gain2);
            gain2.connect(audioCtxPortal.destination);
            osc2.start(now + 0.12);
            osc2.stop(now + 0.52);
        }
    } catch (e) {
        console.warn("Audio en portal no disponible:", e);
    }
}

function mostrarNotificacionMensajePortal({ emisor, texto, canal = "Canal de Red", onClick = null }) {
    let contenedor = document.getElementById("contenedor-notificaciones-mensajes");
    if (!contenedor) {
        contenedor = document.createElement("div");
        contenedor.id = "contenedor-notificaciones-mensajes";
        contenedor.className = "contenedor-notificaciones-mensajes";
        document.body.appendChild(contenedor);
    }

    const card = document.createElement("div");
    card.className = "notificacion-mensaje-card";
    card.setAttribute("role", "alert");
    card.innerHTML = `
        <div class="nm-icono">💬</div>
        <div class="nm-body">
            <div class="nm-header">
                <span class="nm-emisor">${escapeHtml(emisor || "Compañero de Laboratorio")}</span>
                <span class="nm-tiempo">Ahora</span>
            </div>
            <div class="nm-texto">${escapeHtml(texto || "Has recibido un nuevo mensaje")}</div>
            <span class="nm-tag">${escapeHtml(canal)}</span>
        </div>
        <button class="nm-cerrar" title="Cerrar notificación">&times;</button>
    `;

    if (typeof onClick === "function") {
        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("nm-cerrar")) return;
            onClick();
            card.classList.add("fade-out");
            setTimeout(() => card.remove(), 250);
        });
    }

    const btnCerrar = card.querySelector(".nm-cerrar");
    if (btnCerrar) {
        btnCerrar.addEventListener("click", (e) => {
            e.stopPropagation();
            card.classList.add("fade-out");
            setTimeout(() => card.remove(), 250);
        });
    }

    contenedor.appendChild(card);

    setTimeout(() => {
        if (card.parentNode) {
            card.classList.add("fade-out");
            setTimeout(() => card.remove(), 250);
        }
    }, 6500);
}

window.mostrarNotificacionMensajePortal = mostrarNotificacionMensajePortal;
window.reproducirSonidoPortal = reproducirSonidoPortal;

// Desbloquear AudioContext en cualquier interacción del usuario
window.addEventListener("click", () => {
    if (audioCtxPortal && audioCtxPortal.state === "suspended") {
        audioCtxPortal.resume();
    }
}, { passive: true });

// Registrar Service Worker para notificaciones en segundo plano
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => {
        console.log("Service Worker registro opcional:", err);
    });
}

// Despachador universal de notificaciones nativas (Service Worker en móviles/segundo plano + Fallback escritorio)
async function dispararNotificacionSistema(titulo, cuerpo, tag = "comunicado") {
    if (!("Notification" in window) || Notification.permission !== "granted") {
        return;
    }

    const opciones = {
        body: cuerpo,
        icon: "favicon.ico",
        badge: "favicon.ico",
        tag: tag,
        vibrate: [200, 100, 200],
        renotify: true,
        data: { url: window.location.href }
    };

    // 1. En Móviles / Android o en pestañas en segundo plano, new Notification() arroja error:
    // "TypeError: Illegal constructor. Use ServiceWorkerRegistration.showNotification()"
    // Usamos el Service Worker registrado:
    if ("serviceWorker" in navigator) {
        try {
            const reg = await navigator.serviceWorker.ready;
            if (reg && typeof reg.showNotification === "function") {
                await reg.showNotification(titulo, opciones);
                return;
            }
        } catch (swErr) {
            console.warn("Fallo showNotification vía Service Worker:", swErr);
        }
    }

    // 2. Fallback clásico para navegadores de escritorio
    try {
        new Notification(titulo, opciones);
    } catch (notifErr) {
        console.warn("Fallo constructor Notification():", notifErr);
    }
}

function inicializarBotonNotificaciones() {
    const btnNotif = document.querySelector("#btn-activar-notificaciones");
    const txtBtnNotif = document.querySelector("#txt-btn-notif");
    if (!btnNotif) return;

    if (!("Notification" in window)) {
        btnNotif.style.display = "none";
        return;
    }

    if (Notification.permission === "granted") {
        btnNotif.classList.add("enabled");
        if (txtBtnNotif) txtBtnNotif.textContent = "Notificaciones Activas";
    }

    btnNotif.addEventListener("click", async () => {
        try {
            if (audioCtxPortal && audioCtxPortal.state === "suspended") {
                audioCtxPortal.resume();
            } else if (!audioCtxPortal) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) audioCtxPortal = new AudioContextClass();
            }

            const perm = await Notification.requestPermission();
            if (perm === "granted") {
                btnNotif.classList.add("enabled");
                if (txtBtnNotif) txtBtnNotif.textContent = "Notificaciones Activas";
                reproducirSonidoPortal("comunicado");
                await dispararNotificacionSistema(
                    "🛡️ NetworkLab — Notificaciones activadas",
                    "Recibirás avisos de clase y comunicados del docente en este dispositivo con sonido.",
                    "notif-test"
                );
            }
        } catch (err) {
            console.warn("Permiso de notificaciones:", err);
        }
    });
}

// ============================================================
// FORMATEO Y VISTAS DEL PORTAL
// ============================================================
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

// ============================================================
// CONSULTA PRINCIPAL DE ESTADO DE CONEXIÓN
// ============================================================
async function consultarEstadoConexion() {
    try {
        const headers = {};
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        const ipParam = queryIp || (esIpValidaCliente(clienteIpDetectada) ? clienteIpDetectada : "");
        const macParam = queryMac || clienteMacDetectada || "";

        const url = `${API_URL}/portal/estado-conexion?ip=${encodeURIComponent(ipParam)}&mac=${encodeURIComponent(macParam)}`;
        const respuesta = await fetch(url, { headers });
        if (!respuesta.ok) {
            console.warn("Respuesta no satisfactoria del backend:", respuesta.status);
            return;
        }

        const data = await respuesta.json();
        if (esIpValidaCliente(data.ip)) {
            clienteIpDetectada = data.ip;
            if (!queryIp) {
                queryIp = data.ip;
                try {
                    sessionStorage.setItem("lab_portal_client_ip", data.ip);
                    localStorage.setItem("lab_portal_client_ip", data.ip);
                } catch (_) {}
            }
        }
        if (data.mac) {
            clienteMacDetectada = data.mac;
            if (!queryMac) {
                queryMac = data.mac;
                try {
                    sessionStorage.setItem("lab_portal_client_mac", data.mac);
                    localStorage.setItem("lab_portal_client_mac", data.mac);
                } catch (_) {}
            }
        }
        if (data.nombre_host) clienteNombreDetectado = data.nombre_host;
        clienteRolDetectado = data.rol || "nivel_1";

        const badgeRolUsuario = document.querySelector("#badge-rol-usuario");
        const rol = clienteRolDetectado;

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

        // Detectar transición de PENDIENTE a APROBADO
        if (estadoAnterior === "pendiente" && data.estado === "aprobado") {
            reproducirSonidoPortal("aprobado");
            try {
                if ("vibrate" in navigator && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
                    navigator.vibrate([150, 80, 150, 80, 250]);
                }
            } catch (_) {}
            const modalAprobado = document.querySelector("#modal-aprobado-chrome");
            if (modalAprobado) {
                modalAprobado.classList.add("active");
            }
        }
        estadoAnterior = data.estado;

        // 1. Estado: PENDIENTE DE APROBACIÓN
        if (data.estado === "pendiente") {
            cambiarVista("espera");
            esperaEquipo.textContent = data.nombre_host || "Estación de Red";
            esperaIp.textContent = data.ip || "—";
            consultarComunicadosActivos(data.ip, rol);
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

            // Dominios y plataformas autorizadas (Lista Blanca)
            if (listaCategorias) {
                listaCategorias.innerHTML = "";
                const dominios = (data.filtrado_web && data.filtrado_web.dominios_autorizados) || [];
                const cats = (data.filtrado_web && data.filtrado_web.categorias_autorizadas) || [];

                if (dominios.length > 0) {
                    for (const item of dominios) {
                        const span = document.createElement("span");
                        span.className = "allowed-pill";
                        span.textContent = `🌐 ${item.dominio}`;
                        span.title = `Categoría: ${item.categoria || 'Educativa'}`;
                        listaCategorias.appendChild(span);
                    }
                } else if (cats.length > 0) {
                    for (const cat of cats) {
                        const span = document.createElement("span");
                        span.className = "allowed-pill";
                        span.textContent = `📚 ${cat}`;
                        listaCategorias.appendChild(span);
                    }
                } else {
                    listaCategorias.innerHTML = '<span style="color: var(--color-texto-suave); font-size: 0.85rem;">Acceso completo sin restricciones (Modo Administrador/Docente).</span>';
                }
            }

            // Consultar comunicados de red y cargar materiales de laboratorio
            consultarComunicadosActivos(data.ip, rol);
            cargarArchivosPortal(rol);
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

// ============================================================
// COMUNICADOS Y ANUNCIOS EN RED CON SONIDO Y NOTIFICACIÓN
// ============================================================
let comunicadoOcultoId = null;
let mensajeActualMostradoId = null;

async function consultarComunicadosActivos(ip = clienteIpDetectada, rol = clienteRolDetectado) {
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

        // Obtener historial de comunicados ya confirmados como leídos por este equipo
        let leidosLocales = [];
        try {
            leidosLocales = JSON.parse(localStorage.getItem("comunicados_leidos") || "[]");
        } catch (e) {
            leidosLocales = [];
        }

        // Filtrar mensajes que no han sido confirmados como leídos
        const mensajesPendientes = mensajes.filter((m) => !leidosLocales.includes(m.id));
        if (mensajesPendientes.length === 0) {
            banner.style.display = "none";
            return;
        }

        const msg = mensajesPendientes[0];
        mensajeActualMostradoId = msg.id;

        // Si fue cerrado temporalmente en esta sesión sin marcar como leído
        if (comunicadoOcultoId === msg.id) {
            banner.style.display = "none";
            return;
        }

        // Si es un mensaje nuevo que el alumno aún no había visto/escuchado:
        if (ultimoMensajeIdVisto !== msg.id) {
            ultimoMensajeIdVisto = msg.id;
            comunicadoOcultoId = null; // Reiniciar para mostrar el nuevo mensaje siempre

            // Reproducir sonido de alerta
            reproducirSonidoPortal("comunicado");

            // Vibrar en dispositivos móviles
            if ("vibrate" in navigator) {
                navigator.vibrate([200, 100, 200]);
            }

            // Notificación nativa de sistema en Android / Escritorio vía Service Worker
            await dispararNotificacionSistema(`📢 ${msg.titulo}`, msg.contenido, `msg-${msg.id}`);

            // Notificación flotante destacada en pantalla
            mostrarNotificacionMensajePortal({
                emisor: `📢 ${msg.titulo}`,
                texto: msg.contenido,
                canal: "Comunicado de Red"
            });
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

// Botón: Marcar como leído (guarda en localStorage y notifica al servidor para contador x/y)
const btnMarcarLeido = document.querySelector("#btn-marcar-leido");
if (btnMarcarLeido) {
    btnMarcarLeido.addEventListener("click", async () => {
        if (!mensajeActualMostradoId) return;
        const msgId = mensajeActualMostradoId;

        // 1. Guardar persistentemente en localStorage para que no reaparezca nunca más al recargar
        try {
            const leidos = JSON.parse(localStorage.getItem("comunicados_leidos") || "[]");
            if (!leidos.includes(msgId)) {
                leidos.push(msgId);
                localStorage.setItem("comunicados_leidos", JSON.stringify(leidos));
            }
        } catch (e) {
            console.warn("Error guardando lectura en localStorage:", e);
        }

        // 2. Enviar confirmación al backend para reflejarlo en el panel del docente (x/y leídos)
        try {
            await fetch(`${API_URL}/messages/${msgId}/read`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ip: clienteIpDetectada || "",
                    mac: clienteMacDetectada || "",
                    nombre: clienteNombreDetectado || ""
                })
            });
        } catch (e) {
            console.warn("Error notificando lectura al servidor:", e);
        }

        // 3. Ocultar banner suavemente
        const banner = document.querySelector("#banner-comunicado-red");
        if (banner) {
            banner.style.opacity = "0";
            banner.style.transform = "translateY(-8px)";
            setTimeout(() => {
                banner.style.display = "none";
                banner.style.opacity = "";
                banner.style.transform = "";
            }, 250);
        }
    });
}

const btnCerrarComunicado = document.querySelector("#btn-cerrar-comunicado");
if (btnCerrarComunicado) {
    btnCerrarComunicado.addEventListener("click", () => {
        const banner = document.querySelector("#banner-comunicado-red");
        if (banner) banner.style.display = "none";
        if (mensajeActualMostradoId) {
            comunicadoOcultoId = mensajeActualMostradoId;
        }
    });
}

// ============================================================
// PREVISUALIZADOR Y DESCARGA DE ARCHIVOS DE LABORATORIO (PDF.JS & MULTIMEDIA)
// ============================================================
if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./js/pdf.worker.min.js";
}

const modalVisor = document.querySelector("#modal-visor-archivo");
const visorNombre = document.querySelector("#visor-nombre");
const visorMeta = document.querySelector("#visor-meta");
const visorIcono = document.querySelector("#visor-icono");
const visorBody = document.querySelector("#visor-body");
const visorBtnDescargar = document.querySelector("#visor-btn-descargar");
const btnCerrarVisor = document.querySelector("#btn-cerrar-visor");
const btnCerrarVisor2 = document.querySelector("#btn-cerrar-visor-2");

function cerrarVisor() {
    if (modalVisor) {
        modalVisor.classList.remove("active");
        if (visorBody) visorBody.innerHTML = "";
    }
}

if (btnCerrarVisor) btnCerrarVisor.addEventListener("click", cerrarVisor);
if (btnCerrarVisor2) btnCerrarVisor2.addEventListener("click", cerrarVisor);
if (modalVisor) {
    modalVisor.addEventListener("click", (e) => {
        if (e.target === modalVisor) cerrarVisor();
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

async function abrirVisorArchivo(archivo) {
    if (!modalVisor || !visorBody) return;

    const ext = (archivo.nombre_original || "").split(".").pop().toLowerCase();
    const esImagen = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
    const esPdf = ["pdf"].includes(ext);
    const esTexto = ["txt", "log", "csv", "json", "py", "md"].includes(ext);

    visorNombre.textContent = archivo.nombre_original;
    visorMeta.textContent = `${archivo.descripcion ? archivo.descripcion + " • " : ""}${formatearTamanoBytesPortal(archivo.tamano_bytes)}`;
    visorIcono.textContent = obtenerIconoArchivoPortal(archivo.nombre_original);
    visorBtnDescargar.href = `${API_URL}/files/${archivo.id}/download`;

    visorBody.innerHTML = '<div class="pulse-indicator"><span class="pulse-dot"></span> Cargando recurso...</div>';
    modalVisor.classList.add("active");

    const viewUrl = `${API_URL}/files/${archivo.id}/view`;

    if (esImagen) {
        const img = document.createElement("img");
        img.className = "visor-img";
        img.src = viewUrl;
        img.alt = archivo.nombre_original;
        img.onload = () => { visorBody.replaceChildren(img); };
        img.onerror = () => {
            visorBody.innerHTML = `<p style="color: #f87171;">No se pudo previsualizar la imagen.</p>`;
        };
    } else if (esPdf) {
        if (typeof pdfjsLib !== "undefined") {
            visorBody.innerHTML = `
                <div class="pdf-visor-container">
                    <div class="pdf-toolbar">
                        <button type="button" class="pdf-btn" id="pdf-btn-prev">◀ Anterior</button>
                        <span>Pág. <strong id="pdf-num-pag">1</strong> / <strong id="pdf-total-pags">1</strong></span>
                        <button type="button" class="pdf-btn" id="pdf-btn-next">Siguiente ▶</button>
                        <span style="opacity: 0.3; margin: 0 4px;">|</span>
                        <button type="button" class="pdf-btn" id="pdf-btn-zoom-out" title="Reducir zoom">🔍 -</button>
                        <span id="pdf-lbl-zoom" style="font-size: 0.8rem; font-family: monospace; min-width: 42px; text-align: center;">100%</span>
                        <button type="button" class="pdf-btn" id="pdf-btn-zoom-in" title="Aumentar zoom">🔍 +</button>
                    </div>
                    <div class="pdf-canvas-wrap" id="pdf-canvas-container">
                        <div id="pdf-loading-spin" class="pulse-indicator" style="margin: 20px;"><span class="pulse-dot"></span> Cargando documento PDF...</div>
                        <canvas id="pdf-render-canvas" class="pdf-canvas" style="display: none;"></canvas>
                    </div>
                </div>
            `;

            let pdfDoc = null;
            let pageNum = 1;
            let pageRendering = false;
            let pageNumPending = null;
            let scale = 1.0;

            const canvas = document.getElementById("pdf-render-canvas");
            const ctx = canvas ? canvas.getContext("2d") : null;
            const numPagSpan = document.getElementById("pdf-num-pag");
            const totalPagsSpan = document.getElementById("pdf-total-pags");
            const lblZoom = document.getElementById("pdf-lbl-zoom");
            const btnPrev = document.getElementById("pdf-btn-prev");
            const btnNext = document.getElementById("pdf-btn-next");
            const btnZoomIn = document.getElementById("pdf-btn-zoom-in");
            const btnZoomOut = document.getElementById("pdf-btn-zoom-out");
            const loadingSpin = document.getElementById("pdf-loading-spin");

            function renderPage(num) {
                if (!pdfDoc || !canvas || !ctx) return;
                pageRendering = true;
                pdfDoc.getPage(num).then(function(page) {
                    const wrapWidth = Math.max(300, (visorBody.clientWidth || window.innerWidth) - 50);
                    const unscaledViewport = page.getViewport({ scale: 1.0 });
                    const autoFitScale = (unscaledViewport.width > wrapWidth) ? (wrapWidth / unscaledViewport.width) : 1.0;
                    const finalScale = autoFitScale * scale;

                    const viewport = page.getViewport({ scale: finalScale });
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    const renderContext = {
                        canvasContext: ctx,
                        viewport: viewport
                    };
                    const renderTask = page.render(renderContext);

                    renderTask.promise.then(function() {
                        pageRendering = false;
                        if (loadingSpin) loadingSpin.style.display = "none";
                        canvas.style.display = "block";
                        if (pageNumPending !== null) {
                            renderPage(pageNumPending);
                            pageNumPending = null;
                        }
                    }).catch(function(err) {
                        pageRendering = false;
                        console.error("Error al renderizar página PDF:", err);
                    });
                }).catch(function(err) {
                    pageRendering = false;
                    console.error("Error al obtener página PDF:", err);
                });

                if (numPagSpan) numPagSpan.textContent = num;
                if (btnPrev) btnPrev.disabled = (num <= 1);
                if (btnNext) btnNext.disabled = (num >= (pdfDoc ? pdfDoc.numPages : 1));
            }

            function queueRenderPage(num) {
                if (pageRendering) {
                    pageNumPending = num;
                } else {
                    renderPage(num);
                }
            }

            if (btnPrev) {
                btnPrev.onclick = () => {
                    if (pageNum <= 1) return;
                    pageNum--;
                    queueRenderPage(pageNum);
                };
            }

            if (btnNext) {
                btnNext.onclick = () => {
                    if (!pdfDoc || pageNum >= pdfDoc.numPages) return;
                    pageNum++;
                    queueRenderPage(pageNum);
                };
            }

            if (btnZoomIn) {
                btnZoomIn.onclick = () => {
                    if (scale >= 2.5) return;
                    scale = +(scale + 0.25).toFixed(2);
                    if (lblZoom) lblZoom.textContent = `${Math.round(scale * 100)}%`;
                    queueRenderPage(pageNum);
                };
            }

            if (btnZoomOut) {
                btnZoomOut.onclick = () => {
                    if (scale <= 0.5) return;
                    scale = +(scale - 0.25).toFixed(2);
                    if (lblZoom) lblZoom.textContent = `${Math.round(scale * 100)}%`;
                    queueRenderPage(pageNum);
                };
            }

            try {
                const loadingTask = pdfjsLib.getDocument({
                    url: viewUrl,
                    cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/",
                    cMapPacked: true,
                });
                pdfDoc = await loadingTask.promise;
                if (totalPagsSpan) totalPagsSpan.textContent = pdfDoc.numPages;
                renderPage(pageNum);
            } catch (err) {
                console.error("Error al cargar documento PDF con PDF.js:", err);
                visorBody.innerHTML = `
                    <div style="text-align: center; padding: 25px;">
                        <span style="font-size: 3rem; display: block; margin-bottom: 8px;">📑</span>
                        <p style="color: #fca5a5; font-size: 0.95rem; margin-bottom: 12px;">No se pudo procesar la previsualización del documento PDF.</p>
                        <a href="${API_URL}/files/${archivo.id}/download" class="btn" style="background: linear-gradient(135deg, #0284C7, #00E5FF); color: #0B0F19; font-weight: 700; padding: 10px 20px; border-radius: 8px; text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
                            ⬇️ Descargar archivo PDF
                        </a>
                    </div>
                `;
            }
        } else {
            const iframe = document.createElement("iframe");
            iframe.className = "visor-iframe";
            iframe.src = viewUrl;
            visorBody.replaceChildren(iframe);
        }
    } else if (esTexto) {
        try {
            const res = await fetch(viewUrl);
            const texto = await res.text();
            const pre = document.createElement("pre");
            pre.className = "visor-code";
            const code = document.createElement("code");
            code.textContent = texto;
            pre.appendChild(code);
            visorBody.replaceChildren(pre);
        } catch (e) {
            visorBody.innerHTML = `<p style="color: #f87171;">Error al cargar el contenido de texto.</p>`;
        }
    } else {
        visorBody.innerHTML = `
            <div style="text-align: center; padding: 30px;">
                <span style="font-size: 3.5rem; display: block; margin-bottom: 12px;">${obtenerIconoArchivoPortal(archivo.nombre_original)}</span>
                <p style="color: #e2e8f0; font-size: 0.95rem;">Este tipo de archivo (<strong>.${ext}</strong>) no dispone de visualizador directo en pantalla.</p>
                <a href="${API_URL}/files/${archivo.id}/download" class="btn" style="background: linear-gradient(135deg, #0284C7, #00E5FF); color: #0B0F19; font-weight: 700; padding: 10px 20px; border-radius: 8px; text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
                    ⬇️ Descargar archivo directamente
                </a>
            </div>
        `;
    }
}

let idsArchivosConocidosPortal = null;

async function cargarArchivosPortal(rol = clienteRolDetectado) {
    const lista = document.querySelector("#lista-archivos-portal");
    const contador = document.querySelector("#contador-archivos-portal");
    if (!lista) return;

    try {
        const res = await fetch(`${API_URL}/files/?rol=${encodeURIComponent(rol || "nivel_1")}`);
        if (!res.ok) return;
        const archivos = await res.json();

        // Notificar al estudiante si se comparte un nuevo archivo durante su sesión
        const idsActuales = archivos.map((a) => a.id);
        if (idsArchivosConocidosPortal !== null) {
            const nuevosArchivos = archivos.filter((a) => !idsArchivosConocidosPortal.includes(a.id));
            if (nuevosArchivos.length > 0) {
                const ult = nuevosArchivos[0];
                reproducirSonidoPortal("comunicado");
                if ("vibrate" in navigator) {
                    navigator.vibrate([150, 80, 150]);
                }
                await dispararNotificacionSistema(
                    "📁 Nuevo material compartido",
                    `El docente compartió: "${ult.nombre_original}"`,
                    `file-${ult.id}`
                );
            }
        }
        idsArchivosConocidosPortal = idsActuales;

        if (contador) {
            contador.textContent = `${archivos.length} ${archivos.length === 1 ? "recurso disponible" : "recursos disponibles"}`;
        }

        if (archivos.length === 0) {
            lista.innerHTML = '<span style="color: var(--color-texto-suave); font-size: 0.85rem;">No hay archivos compartidos para esta sesión actualmente.</span>';
            return;
        }

        const fragmento = document.createDocumentFragment();
        archivos.forEach((a) => {
            const ext = (a.nombre_original || "").split(".").pop().toLowerCase();
            const esPrevisualizable = ["jpg", "jpeg", "png", "webp", "gif", "pdf", "txt", "log", "csv", "json", "py", "md"].includes(ext);

            const item = document.createElement("div");
            item.className = "portal-file-item";
            item.style.cssText = "display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--color-borde); padding: 12px 16px; border-radius: 10px; gap: 12px; flex-wrap: wrap;";
            const icono = obtenerIconoArchivoPortal(a.nombre_original);

            const leftDiv = document.createElement("div");
            leftDiv.style.cssText = "display: flex; align-items: center; gap: 12px; min-width: 220px;";
            leftDiv.innerHTML = `
                <span style="font-size: 1.6rem; line-height: 1;">${icono}</span>
                <div>
                    <strong class="portal-file-name" style="font-size: 0.95rem; display: block; word-break: break-all;">${a.nombre_original}</strong>
                    <span style="color: var(--color-texto-suave); font-size: 0.8rem;">
                        ${a.descripcion ? a.descripcion + " • " : ""}${formatearTamanoBytesPortal(a.tamano_bytes)}
                    </span>
                </div>
            `;

            const actionsDiv = document.createElement("div");
            actionsDiv.style.cssText = "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;";

            if (esPrevisualizable) {
                const btnVer = document.createElement("button");
                btnVer.type = "button";
                btnVer.className = "btn";
                btnVer.style.cssText = "background: rgba(0, 229, 255, 0.12); color: #00E5FF; border: 1px solid rgba(0, 229, 255, 0.35); font-weight: 600; padding: 7px 14px; font-size: 0.82rem; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;";
                btnVer.innerHTML = `👁️ Previsualizar`;
                btnVer.onclick = () => abrirVisorArchivo(a);
                actionsDiv.appendChild(btnVer);
            }

            const btnDescargar = document.createElement("a");
            btnDescargar.href = `${API_URL}/files/${a.id}/download`;
            btnDescargar.className = "btn";
            btnDescargar.style.cssText = "background: linear-gradient(135deg, #0284C7, #00E5FF); color: #0B0F19; font-weight: 700; padding: 7px 16px; font-size: 0.82rem; text-decoration: none; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 10px rgba(0, 229, 255, 0.2);";
            btnDescargar.target = "_blank";
            btnDescargar.innerHTML = `⬇️ Descargar`;
            actionsDiv.appendChild(btnDescargar);

            item.appendChild(leftDiv);
            item.appendChild(actionsDiv);
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
            btnSolicitarReacceso.innerHTML = "✅ Solicitud enviada al Docente";
            consultarEstadoConexion();
            setTimeout(() => {
                btnSolicitarReacceso.disabled = false;
                btnSolicitarReacceso.innerHTML = "✋ Solicitar Acceso / Nueva Sesión";
            }, 5000);
        }, 1000);
    });
}

// ============================================================
// GESTIÓN DE TEMA EN EL PORTAL (MODO CLARO Y MODO OSCURO)
// ============================================================
function inicializarTemaPortal() {
    const temaGuardado = localStorage.getItem("networklab_theme") || "dark";
    aplicarTemaPortal(temaGuardado);

    const btnToggle = document.querySelector("#btn-toggle-theme");
    if (btnToggle) {
        btnToggle.addEventListener("click", () => {
            const actual = document.documentElement.getAttribute("data-theme") || "dark";
            const nuevo = actual === "light" ? "dark" : "light";
            aplicarTemaPortal(nuevo);
        });
    }
}

function aplicarTemaPortal(tema) {
    document.documentElement.setAttribute("data-theme", tema);
    localStorage.setItem("networklab_theme", tema);

    const icon = document.querySelector("#theme-toggle-icon");
    const txt = document.querySelector("#theme-toggle-text");
    if (icon && txt) {
        if (tema === "light") {
            icon.textContent = "🌙";
            txt.textContent = "Modo Oscuro";
        } else {
            icon.textContent = "☀️";
            txt.textContent = "Modo Claro";
        }
    }
}

// ============================================================
// CHAT COLABORATIVO Y SALA DE TRABAJO (DISCORD / TELEGRAM)
// ============================================================

let chatCanalActivoId = null;
let chatCanalActivoNombre = "Canal de Equipo";
let chatCanalesCache = [];
let chatContactosCache = [];
let chatInfoDispositivo = null;
let chatArchivoSeleccionadoBase64 = null;
let chatArchivoSeleccionadoNombre = null;
let idsMensajesChatConocidos = new Set();
let chatMensajesInicializados = false;

async function cargarCanalesChatPortal() {
    const listaCanales = document.querySelector("#lista-chat-canales");
    const listaContactos = document.querySelector("#lista-chat-contactos");
    const subtituloModo = document.querySelector("#chat-subtitulo-modo");
    const badgeRol = document.querySelector("#badge-chat-mi-rol");
    const btnAttach = document.querySelector("#btn-adjuntar-archivo-chat");

    if (!listaCanales || !listaContactos) return;

    try {
        const ip = clienteIpDetectada || queryIp || "";
        const res = await fetch(`${API_URL}/groups/chat/channels?client_ip=${encodeURIComponent(ip)}`);
        if (!res.ok) return;

        const data = await res.json();
        chatCanalesCache = data.canales || [];
        chatContactosCache = data.contactos || [];
        chatInfoDispositivo = data.dispositivo || {};

        // Actualizar subtítulo y rol del usuario
        if (subtituloModo) {
            if (data.aislamiento_activo) {
                if (chatInfoDispositivo.en_grupo) {
                    subtituloModo.textContent = `Mesa Asignada: ${chatInfoDispositivo.grupo_nombre} (Modo Aislado Activo)`;
                    subtituloModo.style.color = chatInfoDispositivo.grupo_color || "#818cf8";
                } else {
                    subtituloModo.textContent = data.aviso || "Sin mesa de trabajo asignada";
                    subtituloModo.style.color = "#f59e0b";
                }
            } else {
                subtituloModo.textContent = "Modo Red Abierta (Todos los dispositivos conectados)";
                subtituloModo.style.color = "#00E5FF";
            }
        }

        if (badgeRol) {
            if (chatInfoDispositivo.es_lider) {
                badgeRol.textContent = "👑 Líder del Equipo";
                badgeRol.style.background = "rgba(245, 158, 11, 0.15)";
                badgeRol.style.color = "#f59e0b";
                badgeRol.style.borderColor = "rgba(245, 158, 11, 0.35)";
            } else {
                badgeRol.textContent = "Integrante";
                badgeRol.style.background = "rgba(99, 102, 241, 0.15)";
                badgeRol.style.color = "#818cf8";
                badgeRol.style.borderColor = "rgba(99, 102, 241, 0.3)";
            }
        }

        // Habilitar o deshabilitar botón de adjuntar archivos según si es líder
        if (btnAttach) {
            const puedeAdjuntar = !!chatInfoDispositivo.puede_subir_archivos;
            btnAttach.disabled = !puedeAdjuntar;
            btnAttach.title = puedeAdjuntar ? "Adjuntar archivo para el grupo" : "Solo el líder del grupo tiene permisos para compartir archivos";
        }

        // Renderizar Canales de Equipo
        if (chatCanalesCache.length === 0) {
            listaCanales.innerHTML = `<span style="font-size: 0.78rem; color: #64748b; padding: 4px 8px;">Sin canales</span>`;
        } else {
            listaCanales.innerHTML = chatCanalesCache.map(c => {
                const isActive = (c.id === chatCanalActivoId);
                return `
                    <div class="discord-channel-item ${isActive ? 'active' : ''}" data-canal-id="${c.id}" data-canal-nombre="${escapeHtml(c.nombre)}" data-canal-desc="${escapeHtml(c.descripcion || '')}">
                        <span style="font-size: 0.82rem; font-weight: 600;">${escapeHtml(c.nombre)}</span>
                    </div>
                `;
            }).join("");
        }

        // Renderizar Contactos Directos
        if (chatContactosCache.length === 0) {
            listaContactos.innerHTML = `<span style="font-size: 0.78rem; color: #64748b; padding: 4px 8px;">Sin otros integrantes</span>`;
        } else {
            listaContactos.innerHTML = chatContactosCache.map(u => {
                const isActive = (u.id === chatCanalActivoId);
                const corona = u.es_lider ? `👑 ` : ``;
                const statusDot = u.en_linea ? `<span style="color: #10b981;">●</span>` : `<span style="color: #64748b;">○</span>`;
                return `
                    <div class="discord-channel-item ${isActive ? 'active' : ''}" data-canal-id="${u.id}" data-canal-nombre="@ ${escapeHtml(u.nombre)}" data-canal-desc="Mensajes directos con ${escapeHtml(u.nombre)} (${u.ip})">
                        <span style="font-size: 0.82rem;">${statusDot} ${corona}${escapeHtml(u.nombre)}</span>
                    </div>
                `;
            }).join("");
        }

        // Si no hay canal activo seleccionado aún, seleccionar el primero disponible
        if (!chatCanalActivoId && chatCanalesCache.length > 0) {
            seleccionarCanalChat(chatCanalesCache[0].id, chatCanalesCache[0].nombre, "📢", chatCanalesCache[0].descripcion);
        }

        // Wire click events en canales y contactos
        document.querySelectorAll(".discord-channel-item").forEach(item => {
            item.addEventListener("click", () => {
                const cid = item.dataset.canalId;
                const cnombre = item.dataset.canalNombre;
                const cdesc = item.dataset.canalDesc;
                const cicono = cid.startsWith("directo_") ? "👤" : (cid.includes("admin") ? "🛡️" : "📢");
                seleccionarCanalChat(cid, cnombre, cicono, cdesc);
            });
        });
    } catch (e) {
        console.error("Error al cargar canales de chat en portal:", e);
    }
}

function seleccionarCanalChat(canalId, canalNombre, canalIcono, canalDesc) {
    chatCanalActivoId = canalId;
    chatCanalActivoNombre = canalNombre;

    const elTitulo = document.querySelector("#chat-titulo-activo");
    const elIcono = document.querySelector("#chat-icono-activo");
    const elDesc = document.querySelector("#chat-desc-activo");

    if (elTitulo) elTitulo.textContent = canalNombre;
    if (elIcono) elIcono.textContent = canalIcono || "📢";
    if (elDesc) elDesc.textContent = canalDesc || "";

    // Actualizar clase activa en sidebar
    document.querySelectorAll(".discord-channel-item").forEach(item => {
        item.classList.toggle("active", item.dataset.canalId === canalId);
    });

    cargarMensajesCanalActivo();
}

async function cargarMensajesCanalActivo() {
    if (!chatCanalActivoId) return;

    const elHistorial = document.querySelector("#chat-historial-mensajes");
    if (!elHistorial) return;

    try {
        const ip = clienteIpDetectada || queryIp || "";
        const url = `${API_URL}/groups/chat/messages?canal_id=${encodeURIComponent(chatCanalActivoId)}&client_ip=${encodeURIComponent(ip)}`;
        const res = await fetch(url);
        if (!res.ok) return;

        const mensajes = await res.json();

        if (mensajes.length === 0) {
            elHistorial.innerHTML = `
                <div style="text-align: center; padding: 40px 10px; color: var(--color-texto-suave);">
                    <span style="font-size: 2rem; display: block; margin-bottom: 8px;">✨</span>
                    <p style="margin: 0; font-size: 0.9rem;">Comienza la conversación en <strong>${escapeHtml(chatCanalActivoNombre)}</strong>.</p>
                </div>
            `;
            return;
        }

        let huboNuevos = false;
        mensajes.forEach(m => {
            if (!idsMensajesChatConocidos.has(m.id)) {
                idsMensajesChatConocidos.add(m.id);
                huboNuevos = true;
                if (chatMensajesInicializados && !m.es_propio) {
                    reproducirSonidoPortal("mensaje_chat");
                    mostrarNotificacionMensajePortal({
                        emisor: m.emisor_nombre || "Estación de Trabajo",
                        texto: m.tiene_archivo ? `📁 Archivo compartido: ${m.archivo_nombre}` : m.contenido,
                        canal: chatCanalActivoNombre || "Canal de Red",
                        onClick: () => {
                            if (elHistorial) elHistorial.scrollTop = elHistorial.scrollHeight;
                        }
                    });
                }
            }
        });
        chatMensajesInicializados = true;

        const html = mensajes.map(m => {
            const fechaHora = new Date(m.creado_en).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
            const iniciales = (m.emisor_nombre || "PC").substring(0, 2).toUpperCase();

            let archivoHtml = "";
            if (m.tiene_archivo && m.archivo_nombre) {
                archivoHtml = `
                    <a href="${API_URL}/groups/chat/download/${m.id}" download="${escapeHtml(m.archivo_nombre)}" target="_blank" class="chat-file-card">
                        <span style="font-size: 1.3rem;">📄</span>
                        <div style="display: flex; flex-direction: column;">
                            <strong style="font-size: 0.82rem;">${escapeHtml(m.archivo_nombre)}</strong>
                            <span style="font-size: 0.72rem; color: #a5b4fc;">⬇️ Descargar (${formatearTamanoBytesPortal(m.archivo_tamano)})</span>
                        </div>
                    </a>
                `;
            }

            return `
                <div class="chat-bubble ${m.es_propio ? 'own' : ''}">
                    <div class="chat-bubble-avatar">${iniciales}</div>
                    <div class="chat-bubble-content">
                        <div class="chat-bubble-meta">
                            <strong>${m.es_propio ? 'Tú' : escapeHtml(m.emisor_nombre)}</strong>
                            <span>•</span>
                            <span>${fechaHora}</span>
                        </div>
                        <div>${escapeHtml(m.contenido)}</div>
                        ${archivoHtml}
                    </div>
                </div>
            `;
        }).join("");

        elHistorial.innerHTML = html;

        // Auto-scroll al fondo si hay mensajes nuevos
        if (huboNuevos) {
            elHistorial.scrollTop = elHistorial.scrollHeight;
        }
    } catch (e) {
        console.error("Error al cargar mensajes del canal:", e);
    }
}

async function enviarMensajeChatPortal(e) {
    e.preventDefault();
    if (!chatCanalActivoId) return;

    const inputTexto = document.querySelector("#input-chat-texto");
    const btnSend = document.querySelector("#btn-enviar-mensaje-chat");
    const contenido = (inputTexto ? inputTexto.value : "").trim();

    if (!contenido && !chatArchivoSeleccionadoBase64) return;

    let canalTipo = "grupo";
    let grupoIdDest = null;
    let receptorIpDest = null;

    if (chatCanalActivoId.startsWith("grupo_")) {
        canalTipo = "grupo";
        grupoIdDest = parseInt(chatCanalActivoId.replace("grupo_", ""), 10);
    } else if (chatCanalActivoId.startsWith("directo_")) {
        canalTipo = "directo";
        receptorIpDest = chatCanalActivoId.replace("directo_", "").trim();
    } else if (chatCanalActivoId === "admin_directo") {
        canalTipo = "admin";
    } else if (chatCanalActivoId === "red_general") {
        canalTipo = "red_general";
    }

    const payload = {
        canal_tipo: canalTipo,
        grupo_id: grupoIdDest,
        receptor_ip: receptorIpDest,
        contenido: contenido || (chatArchivoSeleccionadoNombre ? `Archivo compartido: ${chatArchivoSeleccionadoNombre}` : "Mensaje"),
        archivo_nombre: chatArchivoSeleccionadoNombre,
        archivo_base64: chatArchivoSeleccionadoBase64,
    };

    if (btnSend) btnSend.disabled = true;

    try {
        const ip = clienteIpDetectada || queryIp || "";
        const res = await fetch(`${API_URL}/groups/chat/messages?client_ip=${encodeURIComponent(ip)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Error al enviar mensaje");
        }

        if (inputTexto) inputTexto.value = "";
        removerAdjuntoChat();
        reproducirSonidoPortal("mensaje_enviado");
        await cargarMensajesCanalActivo();
    } catch (err) {
        console.error("Error al enviar mensaje de chat:", err);
        alert(err.message || "No se pudo enviar el mensaje.");
    } finally {
        if (btnSend) btnSend.disabled = false;
        if (inputTexto) inputTexto.focus();
    }
}

function setupChatAdjuntos() {
    const btnAttach = document.querySelector("#btn-adjuntar-archivo-chat");
    const inputFile = document.querySelector("#input-chat-archivo-adjunto");
    const preview = document.querySelector("#badge-adjunto-preview");
    const txtPreview = document.querySelector("#txt-nombre-adjunto-preview");
    const btnRemover = document.querySelector("#btn-remover-adjunto");

    if (btnAttach && inputFile) {
        btnAttach.addEventListener("click", () => {
            if (!btnAttach.disabled) {
                inputFile.click();
            }
        });
    }

    if (inputFile) {
        inputFile.addEventListener("change", () => {
            const file = inputFile.files[0];
            if (!file) return;

            if (file.size > 25 * 1024 * 1024) {
                alert("El archivo no puede superar los 25 MB.");
                inputFile.value = "";
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const base64Str = e.target.result.split(",")[1];
                chatArchivoSeleccionadoBase64 = base64Str;
                chatArchivoSeleccionadoNombre = file.name;

                if (txtPreview) txtPreview.textContent = file.name;
                if (preview) preview.style.display = "inline-flex";
            };
            reader.readAsDataURL(file);
        });
    }

    if (btnRemover) {
        btnRemover.addEventListener("click", removerAdjuntoChat);
    }
}

function removerAdjuntoChat() {
    chatArchivoSeleccionadoBase64 = null;
    chatArchivoSeleccionadoNombre = null;
    const preview = document.querySelector("#badge-adjunto-preview");
    const inputFile = document.querySelector("#input-chat-archivo-adjunto");
    if (preview) preview.style.display = "none";
    if (inputFile) inputFile.value = "";
}

function inicializarChatColaborativo() {
    setupChatAdjuntos();

    const formChat = document.querySelector("#form-enviar-chat");
    if (formChat) formChat.addEventListener("submit", enviarMensajeChatPortal);

    const btnRefrescar = document.querySelector("#btn-refrescar-chat");
    if (btnRefrescar) {
        btnRefrescar.addEventListener("click", () => {
            cargarCanalesChatPortal();
            cargarMensajesCanalActivo();
        });
    }

    cargarCanalesChatPortal();

    // Polling de chat cada 3 segundos
    setInterval(() => {
        const vistaActiva = document.querySelector("#vista-activa");
        if (vistaActiva && vistaActiva.style.display !== "none") {
            cargarMensajesCanalActivo();
        }
    }, 3000);
}

// ============================================================
// INICIALIZACIÓN
// ============================================================
inicializarTemaPortal();
configurarBotonesIntentChrome();
inicializarBotonNotificaciones();
inicializarChatColaborativo();

// Polling inicial y automático cada 4 segundos
consultarEstadoConexion();
pollingIntervalId = setInterval(consultarEstadoConexion, 4000);

// Polling periódico de comunicados cada 6 segundos
setInterval(() => {
    consultarComunicadosActivos();
}, 6000);

