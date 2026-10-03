const API_URL = `${window.location.protocol}//${window.location.hostname || "localhost"}:8000`;

// --- Autenticación y Verificación de Rol ---
const token = localStorage.getItem("lab_token");
const usuarioStr = localStorage.getItem("lab_usuario");

if (!token || !usuarioStr) {
    window.location.href = "login.html";
}

let usuarioActual = null;
try {
    usuarioActual = JSON.parse(usuarioStr);
    if (usuarioActual.rol !== "admin") {
        window.location.href = "portal.html";
    }
} catch (e) {
    localStorage.clear();
    window.location.href = "login.html";
}

const adminUserDisplay = document.querySelector("#admin-user-display");
if (adminUserDisplay && usuarioActual) {
    adminUserDisplay.textContent = usuarioActual.nombre_completo || usuarioActual.nombre_usuario;
}

const btnLogout = document.querySelector("#btn-logout");
if (btnLogout) {
    btnLogout.addEventListener("click", () => {
        localStorage.clear();
        window.location.href = "login.html";
    });
}

function getAuthHeaders() {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
    };
}

// --- Elementos del DOM ---
const elTablaDispositivos = document.querySelector("#tabla-dispositivos tbody");
const elMensajeDispositivos = document.querySelector("#mensaje-dispositivos");
const elTablaSesiones = document.querySelector("#tabla-sesiones tbody");
const elMensajeSesiones = document.querySelector("#mensaje-sesiones");
const elTablaDominios = document.querySelector("#tabla-dominios tbody");
const elMensajeDominios = document.querySelector("#mensaje-dominios");
const elTablaUsuarios = document.querySelector("#tabla-usuarios tbody");
const elMensajeUsuarios = document.querySelector("#mensaje-usuarios");
const elEstadoConexion = document.querySelector("#estado-conexion");

// Sub-pestañas de Dispositivos e Historial
const elContenedorDispositivos = document.querySelector("#contenedor-dispositivos");
const elContenedorHistorial = document.querySelector("#contenedor-historial");
const elTablaHistorialSesiones = document.querySelector("#tabla-historial-sesiones tbody");
const elMensajeHistorial = document.querySelector("#mensaje-historial");
const elBadgeCountOnline = document.querySelector("#badge-count-online");
const elBadgeCountPending = document.querySelector("#badge-count-pending");
const elBadgeCountAll = document.querySelector("#badge-count-all");

const elTiempoDefault = document.querySelector("#input-tiempo-default");
const elVelocidadDefault = document.querySelector("#select-velocidad-default");
const elInputDominio = document.querySelector("#input-dominio-bloquear");
const elSelectCategoria = document.querySelector("#select-categoria-bloquear");
const elBtnBloquearDominio = document.querySelector("#btn-bloquear-dominio");

// Restaurar y persistir configuraciones por defecto de tiempo y velocidad
if (elTiempoDefault) {
    const savedTiempo = localStorage.getItem("lab_tiempo_default");
    if (savedTiempo) elTiempoDefault.value = savedTiempo;
    elTiempoDefault.addEventListener("input", () => {
        localStorage.setItem("lab_tiempo_default", elTiempoDefault.value);
    });
}
if (elVelocidadDefault) {
    const savedVel = localStorage.getItem("lab_velocidad_default");
    if (savedVel !== null) elVelocidadDefault.value = savedVel;
    elVelocidadDefault.addEventListener("change", () => {
        localStorage.setItem("lab_velocidad_default", elVelocidadDefault.value);
    });
}

// KPIs
const elKpiDispositivos = document.querySelector("#kpi-dispositivos");
const elKpiDispositivosSub = document.querySelector("#kpi-dispositivos-sub");
const elKpiSesionesActivas = document.querySelector("#kpi-sesiones-activas");
const elKpiSesionesSub = document.querySelector("#kpi-sesiones-sub");
const elKpiHoras = document.querySelector("#kpi-horas");
const elKpiDominios = document.querySelector("#kpi-dominios");

let cacheDispositivos = [];
let cacheSesiones = [];
let subtabDispositivosActiva = "online";
let chartConsumoInstance = null;
let chartCategoriasInstance = null;

const badgePorEstado = {
    pending: '<span class="badge badge-pending">Pendiente</span>',
    pendiente: '<span class="badge badge-pending">Pendiente</span>',
    approved: '<span class="badge badge-approved">Aprobado</span>',
    aprobado: '<span class="badge badge-approved">Aprobado</span>',
    rejected: '<span class="badge badge-rejected">Rechazado</span>',
    rechazado: '<span class="badge badge-rejected">Rechazado</span>',
};

function formatearFecha(fechaISO) {
    if (!fechaISO) return "—";
    const fecha = new Date(fechaISO);
    return fecha.toLocaleString("es-AR");
}

function formatearSegundos(totalSegundos) {
    if (totalSegundos === null || totalSegundos === undefined) return "Ilimitado ∞";
    if (totalSegundos <= 0) return "00:00 (Expirado)";

    const horas = Math.floor(totalSegundos / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;
    const pad = (n) => String(n).padStart(2, "0");

    if (horas > 0) {
        return `${pad(horas)}:${pad(minutos)}:${pad(segundos)}`;
    }
    return `${pad(minutos)}:${pad(segundos)}`;
}

// --- Sistema de Pestañas Principales (Tabs) ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

        btn.classList.add("active");
        const targetId = btn.dataset.tab;
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
            targetContent.classList.add("active");
        }

        if (targetId === "tab-estadisticas") {
            cargarEstadisticas();
        } else if (targetId === "tab-usuarios") {
            cargarUsuarios();
        } else if (targetId === "tab-roles") {
            cargarPoliticasRoles();
        } else if (targetId === "tab-archivos") {
            cargarArchivos();
        } else if (targetId === "tab-mensajes") {
            cargarMensajes();
            poblarSelectDispositivosMensaje();
        }
    });
});

// --- Sistema de Sub-pestañas de Dispositivos (Filtros e Historial) ---
document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        subtabDispositivosActiva = btn.dataset.subtab;

        if (subtabDispositivosActiva === "history") {
            if (elContenedorDispositivos) elContenedorDispositivos.style.display = "none";
            if (elMensajeDispositivos) elMensajeDispositivos.style.display = "none";
            if (elContenedorHistorial) elContenedorHistorial.style.display = "block";
            if (elMensajeHistorial) elMensajeHistorial.style.display = "block";
            cargarHistorialSesiones();
        } else {
            if (elContenedorDispositivos) elContenedorDispositivos.style.display = "block";
            if (elMensajeDispositivos) elMensajeDispositivos.style.display = "block";
            if (elContenedorHistorial) elContenedorHistorial.style.display = "none";
            if (elMensajeHistorial) elMensajeHistorial.style.display = "none";
            renderizarDispositivosPorFiltro();
        }
    });
});

// --- 1. Dispositivos y Filtrado por Sub-pestañas ---

let macsConectadasPrevias = null;

async function cargarDispositivos() {
    try {
        const respuesta = await fetch(`${API_URL}/devices/`, { headers: getAuthHeaders() });
        cacheDispositivos = await respuesta.json();

        // Actualizar contadores de las sub-pestañas
        const totalOnline = cacheDispositivos.filter((d) => d.en_linea === true || d.es_admin === true).length;
        const totalPending = cacheDispositivos.filter((d) => (d.estado === "pendiente" || d.estado === "pending") && d.en_linea === true).length;
        const totalAll = cacheDispositivos.length;

        // Detección proactiva de nuevos dispositivos conectados en cualquier módulo
        const onlineDevs = cacheDispositivos.filter((d) => (d.en_linea === true || d.es_admin === true) && !d.es_admin);
        const macsActuales = new Set(onlineDevs.map((d) => (d.direccion_mac || "").toUpperCase()));

        if (macsConectadasPrevias !== null) {
            for (const dev of onlineDevs) {
                const m = (dev.direccion_mac || "").toUpperCase();
                if (m && !macsConectadasPrevias.has(m)) {
                    // ¡Alerta global de nuevo dispositivo conectado!
                    mostrarNotificacionNuevoDispositivo(dev, totalOnline, totalPending);
                }
            }
        }
        macsConectadasPrevias = macsActuales;

        if (elBadgeCountOnline) elBadgeCountOnline.textContent = totalOnline;
        if (elBadgeCountPending) elBadgeCountPending.textContent = totalPending;
        if (elBadgeCountAll) elBadgeCountAll.textContent = totalAll;

        if (subtabDispositivosActiva === "history") {
            cargarHistorialSesiones();
        } else {
            renderizarDispositivosPorFiltro();
        }

        marcarConectado();
    } catch (error) {
        marcarDesconectado();
        console.error("Error cargando dispositivos:", error);
    }
}


// --- Almacén persistente de borradores de configuración por dispositivo ---
// Guarda lo que el operador escribe (rol, minutos, velocidad, clave PIN) en tiempo real
// para que NUNCA se borre ni parpadee ante sincronizaciones en segundo plano.
const borradoresDispositivos = {};

// Escuchar cambios en cualquier input o select de la tabla de dispositivos en tiempo real
elTablaDispositivos.addEventListener("input", (evento) => {
    const input = evento.target;
    const fila = input.closest("tr[data-id]");
    if (!fila) return;
    const devId = fila.dataset.id;
    if (!borradoresDispositivos[devId]) {
        borradoresDispositivos[devId] = { tiempo: "", velocidad: "", clave: "", rol: "nivel_1" };
    }
    if (input.classList.contains("input-tiempo-row")) {
        borradoresDispositivos[devId].tiempo = input.value;
    } else if (input.classList.contains("select-velocidad-row")) {
        borradoresDispositivos[devId].velocidad = input.value;
    } else if (input.id && input.id.startsWith("clave-dev-")) {
        borradoresDispositivos[devId].clave = input.value;
    }
});

elTablaDispositivos.addEventListener("change", (evento) => {
    const target = evento.target;
    const fila = target.closest("tr[data-id]");
    if (!fila) return;
    const devId = fila.dataset.id;
    if (!borradoresDispositivos[devId]) {
        borradoresDispositivos[devId] = { tiempo: "", velocidad: "", clave: "", rol: "nivel_1" };
    }
    if (target.classList.contains("select-velocidad-row")) {
        borradoresDispositivos[devId].velocidad = target.value;
    } else if (target.classList.contains("select-rol-row")) {
        borradoresDispositivos[devId].rol = target.value;
        const inpTiempo = fila.querySelector(`#tiempo-dev-${devId}`);
        const selVel = fila.querySelector(`#velocidad-dev-${devId}`);
        const pol = cachePoliticasRoles[target.value];
        if (pol) {
            const t = (pol.tiempo_defecto_minutos !== null && pol.tiempo_defecto_minutos !== undefined && pol.tiempo_defecto_minutos > 0)
                ? String(pol.tiempo_defecto_minutos) : "";
            const v = (pol.velocidad_defecto_mbps !== null && pol.velocidad_defecto_mbps !== undefined && pol.velocidad_defecto_mbps > 0)
                ? String(pol.velocidad_defecto_mbps) : "";
            if (inpTiempo) { inpTiempo.value = t; borradoresDispositivos[devId].tiempo = t; }
            if (selVel) { selVel.value = v; borradoresDispositivos[devId].velocidad = v; }
        }
    }
});

function generarAccionesHtml(dispositivo, estado, esAdmin, ip, valTiempo, valVel, valClave, limiteVelocidad) {
    if (esAdmin) {
        return `
          <div class="acciones-container">
            <span class="badge" style="background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4); padding: 6px 14px;">
              🛡️ Consola Administradora (Protegida)
            </span>
          </div>
        `;
    }
    if (estado === "pendiente" || estado === "pending" || estado === "rechazado" || estado === "rejected") {
        const valRol = (borradoresDispositivos[dispositivo.id] && borradoresDispositivos[dispositivo.id].rol) || dispositivo.rol || "nivel_1";
        return `
          <div class="row-actions-toolbar">
            <div class="toolbar-inputs-group">
              <div class="field-pill" title="Nivel de acceso / Rol del equipo">
                <span class="pill-label">Rol:</span>
                <select id="rol-dev-${dispositivo.id}" class="pill-select select-rol-row">
                  <option value="nivel_1" ${valRol === "nivel_2" ? "" : "selected"}>Nivel 1</option>
                  <option value="nivel_2" ${valRol === "nivel_2" ? "selected" : ""}>Nivel 2</option>
                </select>
              </div>
              <div class="field-pill" title="Límite de tiempo en minutos (vacío = ilimitado)">
                <span class="pill-label">⏱️</span>
                <input 
                  type="number" 
                  min="1" 
                  id="tiempo-dev-${dispositivo.id}" 
                  placeholder="Min (120)" 
                  value="${valTiempo}"
                  class="pill-input pill-input-time input-tiempo-row" 
                />
              </div>
              <div class="field-pill" title="Límite de ancho de banda QoS MikroTik">
                <span class="pill-label">⚡</span>
                <select id="velocidad-dev-${dispositivo.id}" class="pill-select select-velocidad-row">
                  <option value="" ${valVel === "" ? "selected" : ""}>Vel: Ilim</option>
                  <option value="2" ${valVel === "2" ? "selected" : ""}>2 Mbps</option>
                  <option value="5" ${valVel === "5" ? "selected" : ""}>5 Mbps</option>
                  <option value="10" ${valVel === "10" ? "selected" : ""}>10 Mbps</option>
                  <option value="20" ${valVel === "20" ? "selected" : ""}>20 Mbps</option>
                </select>
              </div>
              <div class="field-pill" title="PIN o clave de acceso para esta PC">
                <span class="pill-label">🔑</span>
                <input 
                  type="text" 
                  id="clave-dev-${dispositivo.id}" 
                  placeholder="PIN" 
                  value="${valClave}"
                  class="pill-input pill-input-pin" 
                />
              </div>
            </div>
            <div class="toolbar-btns-group">
              <button class="btn btn-aprobar" data-id="${dispositivo.id}" data-accion="approve" data-ip="${ip}">
                ✓ Aprobar
              </button>
              ${(estado === "pendiente" || estado === "pending") ? `
              <button class="btn btn-rechazar" data-id="${dispositivo.id}" data-accion="reject">
                ✕ Rechazar
              </button>
              ` : ""}
            </div>
          </div>
        `;
    }
    if (estado === "aprobado" || estado === "approved") {
        const velActual = dispositivo.limite_velocidad_mbps;
        const tiempoActual = dispositivo.limite_tiempo_minutos;
        const rolActual = dispositivo.rol || "nivel_1";

        const badgeRol = rolActual === "nivel_2"
            ? `<span class="user-role-badge role-nivel2" title="Nivel 2: Supervisión / Docentes / Encargados">NIVEL 2</span>`
            : `<span class="user-role-badge role-nivel1" title="Nivel 1: Estándar / Alumnos / Operativo">NIVEL 1</span>`;

        const badgeTiempo = tiempoActual
            ? `<span class="badge-info-dev" title="Tiempo de sesión asignado">⏱️ ${tiempoActual} min</span>`
            : `<span class="badge-info-dev" title="Sesión sin límite de tiempo">⏱️ Ilimitado</span>`;

        const badgeVelocidad = velActual
            ? `<span class="badge-info-dev" title="Límite de velocidad QoS en MikroTik">⚡ ${velActual} Mbps</span>`
            : `<span class="badge-info-dev" title="Velocidad ilimitada">⚡ Ilim</span>`;

        const badgeFiltro = dispositivo.exento_filtro
            ? `<span class="badge-info-dev" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);" title="Esta PC tiene pase libre (YouTube y sitios permitidos)">🔓 Exento</span>`
            : `<span class="badge-info-dev" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);" title="Filtro web activo (Sitios restringidos bloqueados)">🛡️ Filtro</span>`;

        return `
          <div class="row-actions-approved">
            <div class="approved-badges-row">
              ${badgeRol}
              ${badgeTiempo}
              ${badgeVelocidad}
              ${badgeFiltro}
            </div>
            <div class="approved-btns-row">
              <button class="btn btn-configurar-dev" data-id="${dispositivo.id}" title="Editar configuración y políticas de este equipo">
                ⚙️ Configurar
              </button>
              <button class="btn btn-rechazar" data-id="${dispositivo.id}" data-accion="reject" title="Cortar conexión y expulsar del router MikroTik">
                ✕ Rechazar / Expulsar
              </button>
            </div>
          </div>
        `;
    }
    return "";
}

function esMacAleatoria(mac) {
    if (!mac || typeof mac !== "string") return false;
    const parts = mac.trim().split(":");
    if (parts.length === 0 || parts[0].length < 2) return false;
    const primerByte = parseInt(parts[0], 16);
    return !isNaN(primerByte) && Boolean(primerByte & 2);
}

function renderizarDispositivosPorFiltro() {

    let lista = [];
    let mensajeVacio = "";

    if (subtabDispositivosActiva === "online") {
        lista = cacheDispositivos.filter((d) => d.en_linea === true || d.es_admin === true);
        mensajeVacio = "No hay equipos de alumnos conectados activamente en este momento.";
    } else if (subtabDispositivosActiva === "pending") {
        // En Pendientes solo mostrar los que están CONECTADOS AHORA esperando aprobación
        lista = cacheDispositivos.filter((d) => (d.estado === "pendiente" || d.estado === "pending") && d.en_linea === true);
        mensajeVacio = "No hay solicitudes pendientes de equipos conectados en este momento.";
    } else { // "all"
        lista = cacheDispositivos;
        mensajeVacio = 'No hay dispositivos registrados todavía. Probá "Sincronizar dispositivos".';
    }

    if (lista.length === 0) {
        elTablaDispositivos.replaceChildren();
        elMensajeDispositivos.textContent = mensajeVacio;
        return;
    }

    elMensajeDispositivos.textContent = "";

    // Eliminar filas que ya no correspondan al filtro actual
    const idsValidos = new Set(lista.map((d) => String(d.id)));
    elTablaDispositivos.querySelectorAll("tr").forEach((fila) => {
        if (!idsValidos.has(fila.dataset.id)) {
            fila.remove();
        }
    });

    for (const dispositivo of lista) {
        const estado = dispositivo.estado || dispositivo.status;
        const hostname = dispositivo.nombre_host || dispositivo.hostname || "(sin nombre)";
        const ip = dispositivo.direccion_ip || dispositivo.ip_address || "—";
        const mac = dispositivo.direccion_mac || dispositivo.mac_address || "—";
        const ultimaActividad = dispositivo.ultima_actividad || dispositivo.last_seen;
        const limiteVelocidad = dispositivo.limite_velocidad_mbps !== undefined 
            ? dispositivo.limite_velocidad_mbps 
            : dispositivo.bandwidth_limit_mbps;

        const esAdmin = dispositivo.es_admin === true;
        const estaOnline = dispositivo.en_linea === true || esAdmin;

        // Recuperar valores de borrador tipeados por el usuario
        const borrador = borradoresDispositivos[dispositivo.id] || {};
        const valTiempo = borrador.tiempo !== undefined ? borrador.tiempo : "";
        const valVel = borrador.velocidad !== undefined ? borrador.velocidad : "";
        const valClave = borrador.clave !== undefined ? borrador.clave : "";

        let badgePresenciaEstado = "";
        if (esAdmin) {
            badgePresenciaEstado = `<span class="badge" style="background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4);">🛡️ ADMIN</span>`;
        } else {
            const presenciaTag = estaOnline
                ? `<span class="badge badge-online">🟢 Conectado</span>`
                : `<span class="badge badge-offline">⚪ Fuera de línea</span>`;
            const estadoTag = badgePorEstado[estado] || estado;
            badgePresenciaEstado = `<div class="cell-presencia">${presenciaTag}${estadoTag}</div>`;
        }

        const rolDev = dispositivo.rol || "nivel_1";
        const badgeNivel = esAdmin
            ? `<span class="user-role-badge role-admin">ADMIN</span>`
            : (rolDev === "nivel_2"
                ? `<span class="user-role-badge role-nivel2">NIVEL 2</span>`
                : `<span class="user-role-badge role-nivel1">NIVEL 1</span>`);

        const esMacPriv = dispositivo.es_mac_aleatoria === true || esMacAleatoria(mac);
        let hostDisplay = "";
        const nombreCustom = (dispositivo.nombre_host || "").trim();
        const usuarioNombre = (dispositivo.usuario_nombre || "").trim();

        if (nombreCustom) {
            hostDisplay = `<span class="device-hostname" title="Nombre asignado: ${nombreCustom}">${nombreCustom}</span>`;
        } else if (esMacPriv) {
            hostDisplay = `<span class="device-hostname text-muted" title="Este celular usa MAC privada/aleatoria y por diseño de privacidad de Android/iOS no envía nombre por DHCP">📱 Celular <span class="tag-mac-privada" title="MAC aleatoria privada activada en el celular">(MAC Privada)</span></span>`;
        } else {
            hostDisplay = `<span class="device-hostname text-muted">(sin nombre)</span>`;
        }

        const btnRenombrar = esAdmin ? '' : `
            <button class="btn-renombrar-dev" data-id="${dispositivo.id}" data-nombre="${nombreCustom}" title="Asignar o editar nombre a este equipo">✏️</button>
        `;


        const nombreHtml = `
            <div class="device-name-wrap">
                ${hostDisplay}
                ${btnRenombrar}
                ${badgeNivel}
                ${esAdmin ? '<span class="admin-badge-sub">(Tu Netbook)</span>' : ''}
            </div>
        `;
        const fechaHtml = formatearFecha(ultimaActividad);


        let fila = elTablaDispositivos.querySelector(`tr[data-id="${dispositivo.id}"]`);
        const estadoAnterior = fila ? fila.dataset.estado : null;
        const esAdminAnterior = fila ? fila.dataset.esAdmin === "true" : null;

        if (!fila) {
            // Nueva fila: se crea una sola vez
            fila = document.createElement("tr");
            fila.dataset.id = dispositivo.id;
            fila.dataset.estado = estado;
            fila.dataset.esAdmin = String(esAdmin);

            const accionesHtml = generarAccionesHtml(dispositivo, estado, esAdmin, ip, valTiempo, valVel, valClave, limiteVelocidad);

            fila.innerHTML = `
                <td>${badgePresenciaEstado}</td>
                <td>${nombreHtml}</td>
                <td class="cell-mono">${ip}</td>
                <td class="cell-mono">${mac}</td>
                <td>${fechaHtml}</td>
                <td>${accionesHtml}</td>
            `;
            elTablaDispositivos.appendChild(fila);
        } else {
            // Fila existente: actualización IN-PLACE sin parpadeo ni pérdida de foco
            if (fila.children[0] && fila.children[0].innerHTML !== badgePresenciaEstado) {
                fila.children[0].innerHTML = badgePresenciaEstado;
            }
            if (fila.children[1] && fila.children[1].innerHTML !== nombreHtml) {
                fila.children[1].innerHTML = nombreHtml;
            }
            if (fila.children[2] && fila.children[2].textContent !== ip) {
                fila.children[2].textContent = ip;
            }
            if (fila.children[3] && fila.children[3].textContent !== mac) {
                fila.children[3].textContent = mac;
            }
            if (fila.children[4] && fila.children[4].textContent !== fechaHtml) {
                fila.children[4].textContent = fechaHtml;
            }
            if (fila.children[2] && fila.children[2].textContent !== ip) {
                fila.children[2].textContent = ip;
            }
            if (fila.children[3] && fila.children[3].textContent !== mac) {
                fila.children[3].textContent = mac;
            }
            if (fila.children[4] && fila.children[4].textContent !== fechaHtml) {
                fila.children[4].textContent = fechaHtml;
            }

            // Solo si cambió el estado general (ej: pasó de pendiente a aprobado) se recrean las acciones
            if (estadoAnterior !== estado || esAdminAnterior !== esAdmin) {
                fila.dataset.estado = estado;
                fila.dataset.esAdmin = String(esAdmin);
                const accionesHtml = generarAccionesHtml(dispositivo, estado, esAdmin, ip, valTiempo, valVel, valClave, limiteVelocidad);
                if (fila.children[5]) {
                    fila.children[5].innerHTML = accionesHtml;
                }
            } else {
                // Si el estado es el mismo, los inputs NO se tocan si tienen el foco
                const inpTiempo = fila.querySelector(`#tiempo-dev-${dispositivo.id}`);
                const selVel = fila.querySelector(`#velocidad-dev-${dispositivo.id}`);
                const inpClave = fila.querySelector(`#clave-dev-${dispositivo.id}`);

                if (inpTiempo && document.activeElement !== inpTiempo && valTiempo !== "") {
                    if (inpTiempo.value !== valTiempo) inpTiempo.value = valTiempo;
                }
                if (selVel && document.activeElement !== selVel && valVel !== "") {
                    if (selVel.value !== valVel) selVel.value = valVel;
                }
                if (inpClave && document.activeElement !== inpClave && valClave !== "") {
                    if (inpClave.value !== valClave) inpClave.value = valClave;
                }
            }
        }
    }

    // Reordenar filas en el DOM según la lista sin destruirlas
    for (const d of lista) {
        const row = elTablaDispositivos.querySelector(`tr[data-id="${d.id}"]`);
        if (row) elTablaDispositivos.appendChild(row);
    }
}


async function cargarHistorialSesiones() {
    try {
        const respuesta = await fetch(`${API_URL}/sessions/`, { headers: getAuthHeaders() });
        const sesiones = await respuesta.json();

        if (!elTablaHistorialSesiones) return;

        if (!sesiones || sesiones.length === 0) {
            elTablaHistorialSesiones.replaceChildren();
            if (elMensajeHistorial) {
                elMensajeHistorial.textContent = "No hay registros históricos de sesiones todavía.";
            }
            return;
        }

        if (elMensajeHistorial) elMensajeHistorial.textContent = "";

        const fragmento = document.createDocumentFragment();
        for (const s of sesiones) {
            const fila = document.createElement("tr");
            const esActiva = s.esta_activa === true;
            const estadoBadge = esActiva
                ? '<span class="badge badge-approved">🟢 En Curso</span>'
                : '<span class="badge badge-offline">⚪ Finalizada</span>';
            const duracion = esActiva
                ? `En curso (${s.duracion_minutos || 0} min)`
                : `${s.duracion_minutos || 0} min`;
            const qos = s.limite_velocidad_mbps ? `${s.limite_velocidad_mbps} Mbps` : "Ilimitada";

            fila.innerHTML = `
                <td><strong>${s.nombre_host || 'Equipo'}</strong> <br><small style="color:var(--color-texto-suave); font-family:monospace;">${s.direccion_mac || '—'}</small></td>
                <td>${s.direccion_ip || '—'}</td>
                <td>${formatearFecha(s.inicio)}</td>
                <td>${s.fin ? formatearFecha(s.fin) : '<span style="color:#22c55e; font-weight:600;">🟢 En curso</span>'}</td>
                <td>${duracion}</td>
                <td>${qos}</td>
                <td>${estadoBadge}</td>
            `;
            fragmento.appendChild(fila);
        }
        elTablaHistorialSesiones.replaceChildren(fragmento);
    } catch (error) {
        console.error("Error al cargar historial de sesiones:", error);
    }
}

// --- 2. Sesiones Activas y Cuenta Regresiva ---

async function cargarSesionesActivas() {
    try {
        const respuesta = await fetch(`${API_URL}/sessions/active`, { headers: getAuthHeaders() });
        cacheSesiones = await respuesta.json();
        renderizarSesiones();
    } catch (error) {
        console.error("Error cargando sesiones:", error);
    }
}

function renderizarSesiones() {
    if (cacheSesiones.length === 0) {
        elTablaSesiones.replaceChildren();
        elMensajeSesiones.textContent =
            'No hay sesiones activas. Probá "Sincronizar sesiones" con algún dispositivo aprobado y conectado.';
        return;
    }

    elMensajeSesiones.textContent = "";

    // Eliminar filas que ya no estén en cacheSesiones
    const idsValidos = new Set(cacheSesiones.map((s) => String(s.id)));
    elTablaSesiones.querySelectorAll("tr").forEach((row) => {
        if (!idsValidos.has(row.dataset.id)) {
            row.remove();
        }
    });

    for (const sesion of cacheSesiones) {
        const hostname = sesion.nombre_host || sesion.hostname || "(sin nombre)";
        const mac = sesion.direccion_mac || sesion.mac_address || "—";
        const ip = sesion.direccion_ip || sesion.ip_address || "—";
        const inicio = sesion.inicio || sesion.started_at;
        const tiempoRestante = sesion.tiempo_restante_segundos !== undefined 
            ? sesion.tiempo_restante_segundos 
            : sesion.remaining_seconds;
        const limiteVelocidad = sesion.limite_velocidad_mbps !== undefined 
            ? sesion.limite_velocidad_mbps 
            : sesion.bandwidth_limit_mbps;

        let badgeTimerClass = "badge-timer-ok";
        let timerTexto = "Ilimitado ∞";

        if (tiempoRestante !== null && tiempoRestante !== undefined) {
            timerTexto = formatearSegundos(tiempoRestante);
            if (tiempoRestante <= 0) {
                badgeTimerClass = "badge-timer-expired";
            } else if (tiempoRestante <= 180) {
                badgeTimerClass = "badge-timer-warning";
            }
        } else {
            badgeTimerClass = "badge-unlimited";
        }

        const badgeQosHtml = limiteVelocidad
            ? `<span class="badge badge-qos">⚡ ${limiteVelocidad} Mbps</span>`
            : `<span class="badge badge-qos-unlimited">⚡ Ilimitada</span>`;

        let fila = elTablaSesiones.querySelector(`tr[data-id="${sesion.id}"]`);
        if (!fila) {
            fila = document.createElement("tr");
            fila.dataset.id = sesion.id;
            fila.innerHTML = `
                <td>
                  <strong>${hostname}</strong>
                  <br /><small style="color: var(--color-texto-suave)">MAC: ${mac}</small>
                </td>
                <td>${ip}</td>
                <td>${formatearFecha(inicio)}</td>
                <td>
                  <span class="badge ${badgeTimerClass}" id="timer-val-${sesion.id}">
                    ${timerTexto}
                  </span>
                </td>
                <td>${badgeQosHtml}</td>
                <td>
                  <div class="acciones-container">
                    <button class="btn btn-add-time" data-id="${sesion.id}" data-accion="add-time">
                      +15 min
                    </button>
                    <button class="btn btn-cortar" data-id="${sesion.id}" data-accion="disconnect">
                      Cortar
                    </button>
                  </div>
                </td>
            `;
            elTablaSesiones.appendChild(fila);
        } else {
            // Actualización suave in-place sin parpadear
            const celda0 = fila.children[0];
            const nuevo0 = `<strong>${hostname}</strong><br /><small style="color: var(--color-texto-suave)">MAC: ${mac}</small>`;
            if (celda0 && celda0.innerHTML !== nuevo0) celda0.innerHTML = nuevo0;

            const celda1 = fila.children[1];
            if (celda1 && celda1.textContent !== ip) celda1.textContent = ip;

            const celda2 = fila.children[2];
            const fechaStr = formatearFecha(inicio);
            if (celda2 && celda2.textContent !== fechaStr) celda2.textContent = fechaStr;

            const elTimer = fila.querySelector(`#timer-val-${sesion.id}`);
            if (elTimer) {
                if (elTimer.textContent !== timerTexto) elTimer.textContent = timerTexto;
                if (elTimer.className !== `badge ${badgeTimerClass}`) elTimer.className = `badge ${badgeTimerClass}`;
            }

            const celda4 = fila.children[4];
            if (celda4 && celda4.innerHTML !== badgeQosHtml) celda4.innerHTML = badgeQosHtml;
        }
    }

    cacheSesiones.forEach((s) => {
        const row = elTablaSesiones.querySelector(`tr[data-id="${s.id}"]`);
        if (row) elTablaSesiones.appendChild(row);
    });
}

// Cronómetro local que actualiza los segundos restantes cada segundo en pantalla
setInterval(() => {
    let cambio = false;
    for (const s of cacheSesiones) {
        let tiempo = s.tiempo_restante_segundos !== undefined ? s.tiempo_restante_segundos : s.remaining_seconds;
        if (tiempo !== null && tiempo !== undefined && tiempo > 0) {
            tiempo -= 1;
            if (s.tiempo_restante_segundos !== undefined) s.tiempo_restante_segundos = tiempo;
            if (s.remaining_seconds !== undefined) s.remaining_seconds = tiempo;

            const elTimer = document.querySelector(`#timer-val-${s.id}`);
            if (elTimer) {
                elTimer.textContent = formatearSegundos(tiempo);
                if (tiempo <= 0) {
                    elTimer.className = "badge badge-timer-expired";
                    cambio = true;
                } else if (tiempo <= 180) {
                    elTimer.className = "badge badge-timer-warning";
                }
            }
        }
    }
    if (cambio) {
        fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() })
            .then(() => {
                cargarDispositivos();
                cargarSesionesActivas();
            });
    }
}, 1000);

// --- 3. Filtrado de Sitios Web (Bloqueo de Dominios) ---

const selectAlcanceBloquear = document.querySelector("#select-alcance-bloquear");
const contSeleccionPcs = document.querySelector("#contenedor-seleccion-pcs");
const labelSeleccionPcs = document.querySelector("#label-seleccion-pcs");
const listaCheckboxesPcs = document.querySelector("#lista-checkboxes-pcs");

async function actualizarCheckboxesPcs() {
    if (!listaCheckboxesPcs) return;
    if (cacheDispositivos.length === 0) {
        await cargarDispositivos();
    }
    const pcsAlumnos = cacheDispositivos.filter((d) => !d.es_admin);
    if (pcsAlumnos.length === 0) {
        listaCheckboxesPcs.innerHTML = `<span style="color: var(--color-texto-suave); font-size: 0.82rem;">No hay computadoras de alumnos detectadas en este momento.</span>`;
        return;
    }
    listaCheckboxesPcs.innerHTML = pcsAlumnos.map((d) => `
        <label style="display: inline-flex; align-items: center; gap: 6px; background: rgba(15, 23, 42, 0.7); padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12); font-size: 0.85rem; cursor: pointer;">
            <input type="checkbox" class="chk-pc-bloqueo" value="${d.id}" />
            <span><strong>${d.nombre_host || 'PC-' + d.id}</strong> <small style="color: var(--color-texto-suave);">(${d.direccion_ip || 'sin IP'})</small></span>
        </label>
    `).join("");
}

if (selectAlcanceBloquear) {
    selectAlcanceBloquear.addEventListener("change", () => {
        const val = selectAlcanceBloquear.value;
        if (val === "solo_seleccionados" || val === "todos_excepto") {
            if (contSeleccionPcs) contSeleccionPcs.style.display = "block";
            if (labelSeleccionPcs) {
                labelSeleccionPcs.textContent = val === "solo_seleccionados"
                    ? "🎯 Selecciona las computadoras que tendrán BLOQUEADO este sitio:"
                    : "🛡️ Selecciona las computadoras que quedarán EXENTAS de este bloqueo:";
            }
            actualizarCheckboxesPcs();
        } else {
            if (contSeleccionPcs) contSeleccionPcs.style.display = "none";
        }
    });
}

async function cargarDominiosBloqueados() {
    try {
        const respuesta = await fetch(`${API_URL}/filter/domains`, { headers: getAuthHeaders() });
        const dominios = await respuesta.json();

        if (dominios.length === 0) {
            elTablaDominios.replaceChildren();
            elMensajeDominios.textContent = "No hay dominios bloqueados en este momento.";
            return;
        }

        elMensajeDominios.textContent = "";

        const idsValidos = new Set(dominios.map((d) => String(d.id)));
        elTablaDominios.querySelectorAll("tr").forEach((row) => {
            if (!idsValidos.has(row.dataset.id)) {
                row.remove();
            }
        });

        for (const d of dominios) {
            const dom = d.dominio || d.domain;
            const cat = d.categoria || d.category || "General";
            const fecha = d.fecha_creacion || d.created_at;
            const alcance = d.alcance || "todos";

            let badgeAlcance = "";
            const listaNombres = (d.nombres_pcs && d.nombres_pcs.length > 0) ? d.nombres_pcs.join(", ") : "";
            if (alcance === "rol_nivel_1") {
                badgeAlcance = `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35);" title="Aplica a todos los equipos con rol Nivel 1">👥 Solo Nivel 1</span>`;
            } else if (alcance === "rol_nivel_2") {
                badgeAlcance = `<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35);" title="Aplica a todos los equipos con rol Nivel 2">👥 Solo Nivel 2</span>`;
            } else if (alcance === "solo_seleccionados") {
                const cant = d.dispositivos_ids ? d.dispositivos_ids.length : 0;
                badgeAlcance = `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);" title="Afecta a: ${listaNombres}">🎯 Solo ${cant} PC(s)</span>`;
            } else if (alcance === "todos_excepto") {
                const cant = d.dispositivos_ids ? d.dispositivos_ids.length : 0;
                badgeAlcance = `<span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3);" title="Exentas: ${listaNombres}">🛡️ Red (${cant} exenta/s)</span>`;
            } else {
                badgeAlcance = `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);" title="Aplica a toda la red excepto la consola administradora (Admin con Pase Libre)">🌐 Toda la red (Admin Exento)</span>`;
            }

            let fila = elTablaDominios.querySelector(`tr[data-id="${d.id}"]`);
            if (!fila) {
                fila = document.createElement("tr");
                fila.dataset.id = d.id;
                fila.innerHTML = `
                  <td><strong>${dom}</strong></td>
                  <td><span class="badge badge-category">${cat}</span></td>
                  <td>${badgeAlcance}</td>
                  <td>${formatearFecha(fecha)}</td>
                  <td><span class="badge badge-dns-active">🟢 Bloqueado en MikroTik</span></td>
                  <td>
                    <button class="btn btn-desbloquear" data-id="${d.id}" data-accion="unblock-domain">
                      Desbloquear
                    </button>
                  </td>
                `;
                elTablaDominios.appendChild(fila);
            } else {
                if (fila.children[1]) fila.children[1].innerHTML = `<span class="badge badge-category">${cat}</span>`;
                if (fila.children[2]) fila.children[2].innerHTML = badgeAlcance;
            }
        }
    } catch (error) {
        console.error("Error cargando dominios bloqueados:", error);
    }
}

async function bloquearDominio(dominio, categoria = "General", alcance = "todos", dispositivosIds = []) {
    if (!dominio) return;
    try {
        const resp = await fetch(`${API_URL}/filter/domains`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({
                dominio: dominio,
                categoria: categoria,
                alcance: alcance,
                dispositivos_ids: dispositivosIds,
            }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || "Error al bloquear dominio");
            return;
        }
        await cargarDominiosBloqueados();
    } catch (error) {
        console.error("Error al bloquear dominio:", error);
    }
}

async function desbloquearDominio(domainId) {
    try {
        await fetch(`${API_URL}/filter/domains/${domainId}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        });
        await cargarDominiosBloqueados();
    } catch (error) {
        console.error("Error al desbloquear dominio:", error);
    }
}

// --- 4. Estadísticas y Gráficos (Chart.js) ---

async function cargarEstadisticas() {
    try {
        // 1. Resumen KPI
        const resResumen = await fetch(`${API_URL}/stats/resumen`, { headers: getAuthHeaders() });
        const resumen = await resResumen.json();

        if (elKpiDispositivos) elKpiDispositivos.textContent = resumen.dispositivos.total;
        if (elKpiDispositivosSub) elKpiDispositivosSub.textContent = `${resumen.dispositivos.aprobados} aprobados • ${resumen.dispositivos.pendientes} pendientes`;
        if (elKpiSesionesActivas) elKpiSesionesActivas.textContent = resumen.sesiones.activas;
        if (elKpiSesionesSub) elKpiSesionesSub.textContent = `${resumen.sesiones.historicas} sesiones totales`;
        if (elKpiHoras) elKpiHoras.textContent = `${resumen.sesiones.horas_totales} h`;
        if (elKpiDominios) elKpiDominios.textContent = resumen.dominios_bloqueados;

        // 2. Consumo por Equipos (Gráfico de Barras)
        const resConsumo = await fetch(`${API_URL}/stats/consumo-equipos`, { headers: getAuthHeaders() });
        const consumoEquipos = await resConsumo.json();
        renderizarGraficoConsumo(consumoEquipos);

        // 3. Distribución de Categorías (Gráfico de Dona)
        const resCat = await fetch(`${API_URL}/stats/distribucion-categorias`, { headers: getAuthHeaders() });
        const categorias = await resCat.json();
        renderizarGraficoCategorias(categorias);
    } catch (error) {
        console.error("Error al cargar estadísticas:", error);
    }
}

function renderizarGraficoConsumo(datos) {
    const ctx = document.getElementById("chart-consumo");
    if (!ctx) return;

    const labels = datos.map((d) => d.nombre);
    const horas = datos.map((d) => d.horas_conectado);

    if (chartConsumoInstance) {
        chartConsumoInstance.destroy();
    }

    // Paleta armónica inspirada en dashboard SOC / Network Operations (Cian, Violeta, Amanecer, Menta)
    const paletaBarras = [
        "rgba(0, 229, 255, 0.75)",   // Cian eléctrico principal
        "rgba(139, 92, 246, 0.75)",   // Violeta suave
        "rgba(244, 63, 94, 0.75)",    // Coral amanecer
        "rgba(16, 185, 129, 0.75)",   // Verde menta
        "rgba(245, 158, 11, 0.75)",   // Ámbar
        "rgba(56, 189, 248, 0.75)",   // Azul red
    ];
    const bordesBarras = ["#00E5FF", "#8B5CF6", "#F43F5E", "#10B981", "#F59E0B", "#38BDF8"];

    const bgColors = horas.map((_, i) => paletaBarras[i % paletaBarras.length]);
    const borderColors = horas.map((_, i) => bordesBarras[i % bordesBarras.length]);

    chartConsumoInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels.length > 0 ? labels : ["Sin datos"],
            datasets: [
                {
                    label: "Horas de Conexión",
                    data: horas.length > 0 ? horas : [0],
                    backgroundColor: bgColors,
                    borderColor: borderColors,
                    borderWidth: 1.5,
                    borderRadius: 6,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: "#94A3B8", font: { family: "Inter", size: 11 } },
                    grid: { color: "rgba(255, 255, 255, 0.05)" },
                },
                x: {
                    ticks: { color: "#94A3B8", font: { family: "Inter", size: 11 } },
                    grid: { display: false },
                },
            },
        },
    });
}

function renderizarGraficoCategorias(datos) {
    const ctx = document.getElementById("chart-categorias");
    if (!ctx) return;

    const labels = Object.keys(datos);
    const cantidades = Object.values(datos);

    if (chartCategoriasInstance) {
        chartCategoriasInstance.destroy();
    }

    // Paleta armónica balanceada: Cian + Violeta + Coral + Esmeralda + Ámbar
    const coloresDona = [
        "#00E5FF", // Cian Eléctrico
        "#8B5CF6", // Violeta tecnológico
        "#F43F5E", // Amanecer Coral
        "#10B981", // Verde Menta
        "#F59E0B", // Ámbar dorado
        "#38BDF8", // Azul cielo
        "#EC4899", // Rosa magenta
    ];

    chartCategoriasInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: labels.length > 0 ? labels : ["Sin dominios"],
            datasets: [
                {
                    data: cantidades.length > 0 ? cantidades : [1],
                    backgroundColor: coloresDona,
                    hoverBackgroundColor: coloresDona,
                    borderColor: "#121826",
                    borderWidth: 3,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "70%",
            plugins: {
                legend: {
                    position: "right",
                    labels: { color: "#CBD5E1", boxWidth: 12, padding: 14, font: { family: "Inter", size: 12, weight: "500" } },
                },
            },
        },
    });
}

// --- 5. Gestión de Usuarios ---

async function cargarUsuarios() {
    try {
        const resp = await fetch(`${API_URL}/auth/usuarios`, { headers: getAuthHeaders() });
        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) {
                if (elMensajeUsuarios) {
                    elMensajeUsuarios.textContent = "Sesión expirada o no autorizada. Vuelve a iniciar sesión.";
                }
            }
            return;
        }
        const usuarios = await resp.json();

        if (!elTablaUsuarios) return;

        if (!Array.isArray(usuarios) || usuarios.length === 0) {
            elTablaUsuarios.replaceChildren();
            if (elMensajeUsuarios) elMensajeUsuarios.textContent = "No hay usuarios registrados.";
            return;
        }

        if (elMensajeUsuarios) elMensajeUsuarios.textContent = "";

        const actualId = usuarioActual ? usuarioActual.id : null;
        const actualNombre = usuarioActual ? (usuarioActual.nombre_usuario || "") : "";

        const fragmento = document.createDocumentFragment();
        for (const u of usuarios) {
            let badgeRol = '<span class="user-role-badge role-nivel1">NIVEL 1</span>';
            if (u.rol === "admin") {
                badgeRol = '<span class="user-role-badge role-admin">ADMIN</span>';
            } else if (u.rol === "nivel_2" || u.rol === "docente") {
                badgeRol = '<span class="user-role-badge role-nivel2">NIVEL 2</span>';
            }

            const esMismoUsuario = (actualId && u.id === actualId) || (actualNombre && u.nombre_usuario === actualNombre);

            const fila = document.createElement("tr");
            fila.innerHTML = `
              <td>${u.id}</td>
              <td><strong>${u.nombre_usuario}</strong></td>
              <td>${u.nombre_completo || "—"}</td>
              <td>${badgeRol}</td>
              <td>${formatearFecha(u.creado_en)}</td>
              <td>
                ${!esMismoUsuario ? `
                  <button class="btn btn-rechazar btn-eliminar-usuario" data-id="${u.id}">
                    Eliminar
                  </button>
                ` : '<span style="color: var(--color-texto-suave); font-size: 0.8rem;">Sesión Actual</span>'}
              </td>
            `;
            fragmento.appendChild(fila);
        }
        elTablaUsuarios.replaceChildren(fragmento);
    } catch (error) {
        console.error("Error al cargar usuarios:", error);
    }
}

const formCrearUsuario = document.querySelector("#form-crear-usuario");
if (formCrearUsuario) {
    formCrearUsuario.addEventListener("submit", async (e) => {
        e.preventDefault();
        const nombre = document.querySelector("#nuevo-usuario-nombre").value.trim();
        const clave = document.querySelector("#nuevo-usuario-clave").value;
        const completo = document.querySelector("#nuevo-usuario-completo").value.trim();
        const rol = document.querySelector("#nuevo-usuario-rol").value;

        if (!nombre || !clave) return;

        try {
            const resp = await fetch(`${API_URL}/auth/usuarios`, {
                method: "POST",
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    nombre_usuario: nombre,
                    clave: clave,
                    nombre_completo: completo,
                    rol: rol,
                }),
            });

            if (!resp.ok) {
                const err = await resp.json();
                alert(err.detail || "Error al crear usuario");
                return;
            }

            formCrearUsuario.reset();
            await cargarUsuarios();
        } catch (error) {
            console.error("Error creando usuario:", error);
        }
    });
}

// Delegación de eventos para eliminar usuarios
elTablaUsuarios.addEventListener("click", async (evento) => {
    const btn = evento.target.closest(".btn-eliminar-usuario");
    if (!btn) return;
    const userId = btn.dataset.id;
    if (!confirm("¿Seguro que deseas eliminar esta cuenta de usuario?")) return;

    try {
        await fetch(`${API_URL}/auth/usuarios/${userId}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        });
        await cargarUsuarios();
    } catch (error) {
        console.error("Error al eliminar usuario:", error);
    }
});

// --- 6. Acciones y Eventos de Dispositivos y Sesiones ---

async function aprobarORechazar(id, accion, botonEl) {
    try {
        let url = `${API_URL}/devices/${id}/${accion}`;

        if (accion === "approve") {
            const inputTiempoRow = document.querySelector(`#tiempo-dev-${id}`);
            let minutos = inputTiempoRow && inputTiempoRow.value ? parseInt(inputTiempoRow.value) : null;
            if (!minutos && elTiempoDefault && elTiempoDefault.value) {
                minutos = parseInt(elTiempoDefault.value);
            }

            const selectVelRow = document.querySelector(`#velocidad-dev-${id}`);
            let velocidad = selectVelRow && selectVelRow.value ? parseInt(selectVelRow.value) : null;
            if (!velocidad && elVelocidadDefault && elVelocidadDefault.value) {
                velocidad = parseInt(elVelocidadDefault.value);
            }

            const inputClaveRow = document.querySelector(`#clave-dev-${id}`);
            let clavePIN = inputClaveRow && inputClaveRow.value ? inputClaveRow.value.trim() : "1234";

            // Fallback al almacén persistente de borradores por si el elemento no fue leído en el DOM
            const borrador = borradoresDispositivos[id] || {};
            if (!minutos && borrador.tiempo) {
                minutos = parseInt(borrador.tiempo);
            }
            if (!velocidad && borrador.velocidad) {
                velocidad = parseInt(borrador.velocidad);
            }
            if ((!clavePIN || clavePIN === "1234") && borrador.clave) {
                clavePIN = borrador.clave;
            }

            const selectRolRow = document.querySelector(`#rol-dev-${id}`);
            let rolDev = selectRolRow ? selectRolRow.value : (borrador.rol || "nivel_1");

            let ipDispositivo = botonEl && botonEl.dataset.ip ? botonEl.dataset.ip : "";

            const params = new URLSearchParams();
            params.append("rol", rolDev);
            if (minutos && minutos > 0) params.append("time_limit_minutes", minutos);
            if (velocidad && velocidad > 0) params.append("bandwidth_limit_mbps", velocidad);
            if (clavePIN) params.append("custom_password", clavePIN);
            if (ipDispositivo && ipDispositivo !== "—") params.append("custom_username", ipDispositivo);

            const queryString = params.toString();
            if (queryString) {
                url += `?${queryString}`;
            }
        }

        await fetch(url, { method: "POST", headers: getAuthHeaders() });
        await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });

        // Limpiar el borrador una vez procesada la acción
        delete borradoresDispositivos[id];
    } catch (error) {
        console.error(`Error al ejecutar acción ${accion}:`, error);
    } finally {
        await cargarDispositivos();
        await cargarSesionesActivas();
    }
}

async function manejarCambioVelocidad(deviceId, nuevaVelocidad) {
    try {
        const velParam = nuevaVelocidad ? `?bandwidth_limit_mbps=${nuevaVelocidad}` : "";
        await fetch(`${API_URL}/devices/${deviceId}/bandwidth${velParam}`, {
            method: "POST",
            headers: getAuthHeaders(),
        });
    } catch (error) {
        console.error("Error al actualizar velocidad QoS:", error);
    } finally {
        await cargarDispositivos();
        await cargarSesionesActivas();
    }
}

async function manejarAccionSesion(sessionId, accion) {
    try {
        if (accion === "add-time") {
            const minutosStr = prompt("¿Cuántos minutos deseas agregar?", "15");
            if (!minutosStr) return;
            const minutos = parseInt(minutosStr);
            if (isNaN(minutos) || minutos <= 0) return;

            await fetch(`${API_URL}/sessions/${sessionId}/add-time?minutes=${minutos}`, {
                method: "POST",
                headers: getAuthHeaders(),
            });
        } else if (accion === "disconnect") {
            if (!confirm("¿Seguro que deseas cortar la conexión de este dispositivo?")) return;
            await fetch(`${API_URL}/sessions/${sessionId}/disconnect`, {
                method: "POST",
                headers: getAuthHeaders(),
            });
        }
    } catch (error) {
        console.error(`Error en acción de sesión ${accion}:`, error);
    } finally {
        await cargarDispositivos();
        await cargarSesionesActivas();
    }
}

function marcarConectado() {
    elEstadoConexion.textContent = "Conectado al backend";
    elEstadoConexion.style.color = "#22c55e";
}

function marcarDesconectado() {
    elEstadoConexion.textContent =
        "No se pudo conectar al backend (¿está corriendo docker-compose?)";
    elEstadoConexion.style.color = "#ef4444";
}

// --- Modal de Configuración de Dispositivo ---
const modalConfigDev = document.querySelector("#modal-config-dispositivo");
const modalConfigTitulo = document.querySelector("#modal-config-titulo");
const modalInfoTags = document.querySelector("#modal-info-tags");
const formConfigDev = document.querySelector("#form-config-dispositivo");
const inputConfigDevId = document.querySelector("#modal-config-dev-id");
const inputConfigNombre = document.querySelector("#modal-config-nombre");
const inputConfigTiempo = document.querySelector("#modal-config-tiempo");
const selectConfigVelocidad = document.querySelector("#modal-config-velocidad");
const selectConfigRol = document.querySelector("#modal-config-rol");
const selectConfigFiltro = document.querySelector("#modal-config-filtro");
const btnCerrarModalConfig = document.querySelector("#btn-cerrar-modal-config");
const btnCancelarModalConfig = document.querySelector("#btn-cancelar-modal-config");

if (selectConfigRol) {
    selectConfigRol.addEventListener("change", () => {
        const pol = cachePoliticasRoles[selectConfigRol.value];
        if (pol) {
            inputConfigTiempo.value = (pol.tiempo_defecto_minutos !== null && pol.tiempo_defecto_minutos !== undefined && pol.tiempo_defecto_minutos > 0)
                ? String(pol.tiempo_defecto_minutos) : "";
            selectConfigVelocidad.value = (pol.velocidad_defecto_mbps !== null && pol.velocidad_defecto_mbps !== undefined && pol.velocidad_defecto_mbps > 0)
                ? String(pol.velocidad_defecto_mbps) : "";
            if (selectConfigFiltro) {
                selectConfigFiltro.value = pol.exento_filtro_defecto ? "true" : "false";
            }
        }
    });
}

function abrirModalConfiguracion(deviceId) {
    const dev = cacheDispositivos.find((d) => String(d.id) === String(deviceId));
    if (!dev) return;

    inputConfigDevId.value = dev.id;
    modalConfigTitulo.textContent = `⚙️ Configurar: ${dev.nombre_host || "Equipo"}`;

    modalInfoTags.innerHTML = `
        <span class="badge-info-dev">💻 IP: <strong>${dev.direccion_ip || "—"}</strong></span>
        <span class="badge-info-dev">🏷️ MAC: <strong>${dev.direccion_mac || "—"}</strong></span>
        <span class="badge-info-dev">🟢 Estado: <strong>${dev.estado || "Aprobado"}</strong></span>
    `;

    inputConfigNombre.value = dev.nombre_host || "";
    if (selectConfigRol) {
        selectConfigRol.value = dev.rol || "nivel_1";
    }
    inputConfigTiempo.value = dev.limite_tiempo_minutos !== undefined && dev.limite_tiempo_minutos !== null ? dev.limite_tiempo_minutos : "";
    selectConfigVelocidad.value = dev.limite_velocidad_mbps !== undefined && dev.limite_velocidad_mbps !== null
        ? String(dev.limite_velocidad_mbps)
        : "";
    if (selectConfigFiltro) {
        selectConfigFiltro.value = dev.exento_filtro ? "true" : "false";
    }

    modalConfigDev.style.display = "flex";
}

function cerrarModalConfiguracion() {
    if (modalConfigDev) modalConfigDev.style.display = "none";
}

if (btnCerrarModalConfig) btnCerrarModalConfig.addEventListener("click", cerrarModalConfiguracion);
if (btnCancelarModalConfig) btnCancelarModalConfig.addEventListener("click", cerrarModalConfiguracion);
if (modalConfigDev) {
    modalConfigDev.addEventListener("click", (e) => {
        if (e.target === modalConfigDev) cerrarModalConfiguracion();
    });
}

if (formConfigDev) {
    formConfigDev.addEventListener("submit", async (e) => {
        e.preventDefault();
        const devId = inputConfigDevId.value;
        const nombre = inputConfigNombre.value.trim();
        const rol = selectConfigRol ? selectConfigRol.value : "nivel_1";
        const tiempo = inputConfigTiempo.value ? parseInt(inputConfigTiempo.value) : null;
        const velocidad = selectConfigVelocidad.value ? parseInt(selectConfigVelocidad.value) : null;
        const exento = selectConfigFiltro ? (selectConfigFiltro.value === "true") : false;

        try {
            const params = new URLSearchParams();
            if (rol) params.append("rol", rol);
            if (tiempo && tiempo > 0) params.append("time_limit_minutes", tiempo);
            if (velocidad && velocidad > 0) params.append("bandwidth_limit_mbps", velocidad);
            if (nombre) params.append("nombre_host", nombre);
            params.append("exento_filtro", exento);

            await fetch(`${API_URL}/devices/${devId}/config?${params.toString()}`, {
                method: "POST",
                headers: getAuthHeaders(),
            });

            await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });
            cerrarModalConfiguracion();
        } catch (error) {
            console.error("Error al guardar configuración de equipo:", error);
            alert("No se pudo guardar la configuración");
        } finally {
            await cargarDispositivos();
            await cargarSesionesActivas();
        }
    });
}

// Delegación de eventos para la tabla de dispositivos
elTablaDispositivos.addEventListener("click", (evento) => {
    const btnRenombrar = evento.target.closest(".btn-renombrar-dev");
    if (btnRenombrar) {
        renombrarDispositivo(btnRenombrar.dataset.id, btnRenombrar.dataset.nombre || "");
        return;
    }
    const btnConfig = evento.target.closest(".btn-configurar-dev");
    if (btnConfig) {
        abrirModalConfiguracion(btnConfig.dataset.id);
        return;
    }
    const btnEliminar = evento.target.closest(".btn-eliminar-dev");
    if (btnEliminar) {
        eliminarDispositivo(btnEliminar.dataset.id);
        return;
    }
    const boton = evento.target.closest("button[data-accion]");
    if (!boton) return;
    aprobarORechazar(boton.dataset.id, boton.dataset.accion, boton);
});

async function renombrarDispositivo(devId, nombreActual) {
    const nuevoNombre = prompt("Asignar nombre identificador a este dispositivo (ej: 'Celular de Nachu', 'Tablet Alumno 1'):", nombreActual);
    if (nuevoNombre === null) return;
    try {
        const res = await fetch(`${API_URL}/devices/${devId}/rename`, {
            method: "POST",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ nombre_host: nuevoNombre.trim() })
        });
        if (res.ok) {
            mostrarToast("✓ Nombre del equipo actualizado");
            await cargarDispositivos();
        } else {
            const err = await res.json();
            mostrarToast(err.detail || "Error al renombrar", true);
        }
    } catch (e) {
        console.error(e);
        mostrarToast("Error de conexión al renombrar", true);
    }
}

async function eliminarDispositivo(devId) {
    if (!confirm("¿Deseas eliminar este dispositivo de la lista registrada?")) return;
    try {
        const res = await fetch(`${API_URL}/devices/${devId}`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });
        if (res.ok) {
            mostrarToast("✓ Dispositivo eliminado del registro");
            await cargarDispositivos();
        } else {
            const err = await res.json();
            mostrarToast(err.detail || "Error al eliminar dispositivo", true);
        }
    } catch (e) {
        console.error(e);
        mostrarToast("Error de conexión al eliminar", true);
    }
}


// Botón Limpiar Inactivos
const btnPurgeOffline = document.querySelector("#btn-purge-offline");
if (btnPurgeOffline) {
    btnPurgeOffline.addEventListener("click", async () => {
        if (!confirm("¿Deseas depurar y limpiar todos los equipos que actualmente están desconectados?")) return;
        try {
            btnPurgeOffline.disabled = true;
            btnPurgeOffline.textContent = "⏳ Limpiando...";
            const res = await fetch(`${API_URL}/devices/purge-offline`, {
                method: "POST",
                headers: getAuthHeaders()
            });
            const data = await res.json();
            if (res.ok) {
                mostrarToast(`✓ Se limpiaron ${data.purgados || 0} dispositivos inactivos`);
                await cargarDispositivos();
            } else {
                mostrarToast("Error al limpiar dispositivos", true);
            }
        } catch (e) {
            console.error(e);
            mostrarToast("Error al limpiar dispositivos", true);
        } finally {
            btnPurgeOffline.disabled = false;
            btnPurgeOffline.textContent = "🧹 Limpiar Inactivos";
        }
    });
}

elTablaDispositivos.addEventListener("change", (evento) => {
    const select = evento.target.closest(".select-change-speed");
    if (!select) return;
    manejarCambioVelocidad(select.dataset.id, select.value ? parseInt(select.value) : null);
});

// Delegación de eventos para la tabla de sesiones
elTablaSesiones.addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-accion]");
    if (!boton) return;
    manejarAccionSesion(boton.dataset.id, boton.dataset.accion);
});

// Delegación de eventos para la tabla de dominios
elTablaDominios.addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-accion='unblock-domain']");
    if (!boton) return;
    desbloquearDominio(boton.dataset.id);
});

// Botón para bloquear dominio manual
if (elBtnBloquearDominio) {
    elBtnBloquearDominio.addEventListener("click", () => {
        const dom = elInputDominio ? elInputDominio.value.trim() : "";
        const cat = elSelectCategoria ? elSelectCategoria.value : "General";
        const alc = selectAlcanceBloquear ? selectAlcanceBloquear.value : "todos";

        if (!dom) {
            alert("Por favor escribe un dominio (ej: youtube.com)");
            return;
        }

        const chks = document.querySelectorAll(".chk-pc-bloqueo:checked");
        const devIds = Array.from(chks).map((c) => parseInt(c.value));

        if ((alc === "solo_seleccionados" || alc === "todos_excepto") && devIds.length === 0) {
            alert("Por favor selecciona al menos una computadora de la lista para este alcance.");
            return;
        }

        bloquearDominio(dom, cat, alc, devIds);
        if (elInputDominio) elInputDominio.value = "";
    });
}

// Botones de bloqueo rápido
document.querySelectorAll(".btn-quick-block").forEach((btn) => {
    btn.addEventListener("click", () => {
        if (elInputDominio) elInputDominio.value = btn.dataset.domain;
        if (elSelectCategoria) elSelectCategoria.value = btn.dataset.cat;
        const alc = selectAlcanceBloquear ? selectAlcanceBloquear.value : "todos";
        const chks = document.querySelectorAll(".chk-pc-bloqueo:checked");
        const devIds = Array.from(chks).map((c) => parseInt(c.value));

        if ((alc === "solo_seleccionados" || alc === "todos_excepto") && devIds.length === 0) {
            alert("Selecciona al menos una computadora para aplicar este bloqueo selectivo, o cambia el alcance a 'Toda la sala'.");
            return;
        }

        bloquearDominio(btn.dataset.domain, btn.dataset.cat, alc, devIds);
    });
});

// ============================================================
// 1. NOTIFICACIÓN HUD RADAR: NUEVO DISPOSITIVO CONECTADO
// (Aparece en cualquier módulo cuando alguien se conecta al Wi-Fi)
// ============================================================
let timeoutRadarHud = null;

function mostrarNotificacionNuevoDispositivo(dev, totalOnline = "—", totalPending = "—") {
    let hud = document.querySelector("#network-radar-hud");
    if (!hud) {
        hud = document.createElement("div");
        hud.id = "network-radar-hud";
        hud.className = "network-radar-hud";
        document.body.appendChild(hud);
    }

    const host = dev.nombre_host || (dev.es_mac_aleatoria ? "📱 Celular / Móvil" : "💻 Dispositivo en Red");
    const ip = dev.direccion_ip || "IP asignada";
    const mac = dev.direccion_mac || "—";
    const routerHost = "192.168.88.1";

    hud.innerHTML = `
        <div class="hud-scanline"></div>
        <div class="hud-main-content">
            <div class="hud-radar-visual">
                <div class="hud-radar-circle">
                    <div class="hud-radar-sweep"></div>
                    <div class="hud-radar-ping"></div>
                    <div class="hud-radar-node node-center"></div>
                    <div class="hud-radar-node node-1"></div>
                    <div class="hud-radar-node node-2"></div>
                </div>
            </div>
            <div class="hud-info">
                <div class="hud-header">
                    <div class="hud-title">
                        <span class="hud-icon">📡</span>
                        <span>¡Nuevo Dispositivo Conectado!</span>
                    </div>
                    <span class="hud-router-badge">🟢 MikroTik ${routerHost}</span>
                </div>
                <div style="font-size: 0.84rem; color: #f1f5f9; margin-bottom: 6px; font-weight: 700;">
                    ${host} <span style="font-family: var(--font-mono); color: #38bdf8; font-size: 0.76rem; font-weight: 500;">(${ip})</span>
                </div>
                <div class="hud-stats-row">
                    <div class="hud-stat-pill stat-online">
                        <span class="hud-stat-label">En Línea Ahora</span>
                        <span class="hud-stat-val">🟢 ${totalOnline}</span>
                    </div>
                    <div class="hud-stat-pill stat-pending">
                        <span class="hud-stat-label">Por Autorizar</span>
                        <span class="hud-stat-val">⏳ ${totalPending}</span>
                    </div>
                    <div class="hud-stat-pill">
                        <span class="hud-stat-label">Dirección MAC</span>
                        <span class="hud-stat-val" style="font-size: 0.72rem; font-family: var(--font-mono);">${mac}</span>
                    </div>
                </div>
                <div class="hud-footer-msg">
                    <span>⚡ Detección automática en tiempo real</span>
                    <span class="hud-dismiss-btn" title="Cerrar">×</span>
                </div>
            </div>
        </div>
    `;

    // Forzar reinicio de animación
    hud.classList.remove("show");
    void hud.offsetWidth;
    hud.classList.add("show");

    const btnCerrar = hud.querySelector(".hud-dismiss-btn");
    if (btnCerrar) {
        btnCerrar.onclick = () => {
            hud.classList.remove("show");
            if (timeoutRadarHud) clearTimeout(timeoutRadarHud);
        };
    }

    if (timeoutRadarHud) clearTimeout(timeoutRadarHud);
    timeoutRadarHud = setTimeout(() => {
        hud.classList.remove("show");
    }, 6000);
}

// ============================================================
// 2. MODAL CENTRADO DE TRANSMISIÓN DE DATOS (SINCRONIZACIÓN)
// (Simula el envío y recepción de paquetes de red en pantalla)
// ============================================================
let timeoutDatastreamModal = null;

function mostrarModalTransmisionDatosSincronizacion(datosSync = {}) {
    let overlay = document.querySelector("#sync-datastream-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "sync-datastream-overlay";
        overlay.className = "sync-datastream-overlay";
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay || e.target.closest(".datastream-footer")) {
                overlay.classList.remove("show");
                if (timeoutDatastreamModal) clearTimeout(timeoutDatastreamModal);
            }
        });
    }

    const nuevos = datosSync.nuevos ?? 0;
    const totalOnline = datosSync.totalOnline ?? "—";
    const totalLeases = datosSync.totalLeases ?? "—";
    const routerHost = "192.168.88.1";

    overlay.innerHTML = `
        <div class="sync-datastream-modal">
            <div class="datastream-laser-bar"></div>
            <div class="datastream-content">
                <div class="datastream-badge-top">
                    <span>🛰️ MikroTik RouterOS (${routerHost})</span>
                </div>
                <h3 class="datastream-title">⚡ Sincronización de Red Exitosa</h3>

                <!-- Animación de flujo de paquetes de red -->
                <div class="datastream-pipeline">
                    <div class="datastream-node node-router">
                        <div class="datastream-node-icon">🛰️</div>
                        <span>Router MikroTik</span>
                    </div>
                    <div class="datastream-wire-container">
                        <div class="datastream-wire">
                            <div class="datastream-packet"></div>
                            <div class="datastream-packet"></div>
                            <div class="datastream-packet"></div>
                        </div>
                        <span class="datastream-bitstream">TRANSMISIÓN DE PAQUETES BIDIRECCIONAL</span>
                    </div>
                    <div class="datastream-node node-server">
                        <div class="datastream-node-icon">💻</div>
                        <span>Consola Lab</span>
                    </div>
                </div>

                <!-- Métricas de la sincronización -->
                <div class="datastream-metrics">
                    <div class="datastream-metric-box metric-nuevos">
                        <span class="datastream-metric-label">Nuevos Detectados</span>
                        <span class="datastream-metric-val">${nuevos}</span>
                    </div>
                    <div class="datastream-metric-box metric-online">
                        <span class="datastream-metric-label">En Línea Ahora</span>
                        <span class="datastream-metric-val">🟢 ${totalOnline}</span>
                    </div>
                    <div class="datastream-metric-box metric-leases">
                        <span class="datastream-metric-label">Concesiones DHCP</span>
                        <span class="datastream-metric-val">${totalLeases}</span>
                    </div>
                </div>

                <div class="datastream-footer">
                    <span>✅ Topología de red y estados sincronizados correctamente</span>
                </div>
            </div>
        </div>
    `;

    overlay.classList.remove("show");
    void overlay.offsetWidth;
    overlay.classList.add("show");

    if (timeoutDatastreamModal) clearTimeout(timeoutDatastreamModal);
    timeoutDatastreamModal = setTimeout(() => {
        overlay.classList.remove("show");
    }, 2800);
}

const btnSyncDevices = document.querySelector("#btn-sync-devices");
if (btnSyncDevices) {
    btnSyncDevices.addEventListener("click", async () => {
        const originalHtml = btnSyncDevices.innerHTML;
        btnSyncDevices.classList.add("btn-scanning");
        btnSyncDevices.innerHTML = `<span class="btn-icon">📡</span> Escaneando red...`;

        try {
            const resDevices = await fetch(`${API_URL}/devices/sync`, { method: "POST", headers: getAuthHeaders() });
            const dataDevices = resDevices.ok ? await resDevices.json() : {};
            await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });

            await cargarDispositivos();
            await cargarSesionesActivas();

            const totalOnline = document.querySelector("#badge-count-online") ? document.querySelector("#badge-count-online").textContent : "0";
            const totalPending = document.querySelector("#badge-count-pending") ? document.querySelector("#badge-count-pending").textContent : "0";
            const totalLeases = dataDevices.total_leases ?? (document.querySelector("#badge-count-all") ? document.querySelector("#badge-count-all").textContent : "0");

            mostrarModalTransmisionDatosSincronizacion({
                totalLeases,
                totalOnline,
                totalPendientes: totalPending,
                nuevos: dataDevices.nuevos_detectados || 0
            });

            btnSyncDevices.innerHTML = `<span class="btn-icon">✅</span> ¡Red Sincronizada!`;
            setTimeout(() => {
                btnSyncDevices.classList.remove("btn-scanning");
                btnSyncDevices.innerHTML = originalHtml;
            }, 1300);
        } catch (error) {
            console.error("Error sincronizando dispositivos:", error);
            mostrarToast("Error conectando con MikroTik al sincronizar", true);
            btnSyncDevices.classList.remove("btn-scanning");
            btnSyncDevices.innerHTML = originalHtml;
        }
    });
}

const btnSyncSessions = document.querySelector("#btn-sync-sessions");
if (btnSyncSessions) {
    btnSyncSessions.addEventListener("click", async () => {
        const originalHtml = btnSyncSessions.innerHTML;
        btnSyncSessions.classList.add("btn-scanning");
        btnSyncSessions.innerHTML = `<span class="btn-icon">📡</span> Sincronizando...`;

        try {
            await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });
            await cargarSesionesActivas();
            await cargarDispositivos();

            const totalOnline = document.querySelector("#badge-count-online") ? document.querySelector("#badge-count-online").textContent : "0";
            const totalPending = document.querySelector("#badge-count-pending") ? document.querySelector("#badge-count-pending").textContent : "0";
            const totalLeases = document.querySelector("#badge-count-all") ? document.querySelector("#badge-count-all").textContent : "0";

            mostrarModalTransmisionDatosSincronizacion({
                totalLeases,
                totalOnline,
                totalPendientes: totalPending,
                nuevos: 0
            });

            btnSyncSessions.innerHTML = `<span class="btn-icon">✅</span> ¡Sesiones al día!`;
            setTimeout(() => {
                btnSyncSessions.classList.remove("btn-scanning");
                btnSyncSessions.innerHTML = originalHtml;
            }, 1300);
        } catch (error) {
            console.error("Error sincronizando sesiones:", error);
            mostrarToast("Error sincronizando sesiones", true);
            btnSyncSessions.classList.remove("btn-scanning");
            btnSyncSessions.innerHTML = originalHtml;
        }
    });
}



const btnRefrescarStats = document.querySelector("#btn-refrescar-stats");
if (btnRefrescarStats) {
    btnRefrescarStats.addEventListener("click", cargarEstadisticas);
}

// ============================================================
// SISTEMA DE NOTIFICACIONES TOAST PREMIUM
// ============================================================
function mostrarToast(mensaje, esError = false) {
    let toast = document.querySelector("#global-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "global-toast";
        document.body.appendChild(toast);
    }
    toast.textContent = mensaje;
    toast.className = `global-toast ${esError ? "toast-error" : "toast-success"} show`;
    setTimeout(() => {
        toast.classList.remove("show");
    }, 3500);
}

// ============================================================
// POLÍTICAS Y PERMISOS DE ROLES (NIVEL 1, NIVEL 2, ADMIN)
// ============================================================
let cachePoliticasRoles = {
    nivel_1: { tiempo_defecto_minutos: 120, velocidad_defecto_mbps: 10, exento_filtro_defecto: false, permite_reacceso: true },
    nivel_2: { tiempo_defecto_minutos: 0, velocidad_defecto_mbps: 0, exento_filtro_defecto: true, permite_reacceso: true },
    admin: { tiempo_defecto_minutos: 0, velocidad_defecto_mbps: 0, exento_filtro_defecto: true, permite_reacceso: true }
};

async function cargarPoliticasRoles() {
    try {
        const res = await fetch(`${API_URL}/roles/policies`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const politicas = await res.json();
        politicas.forEach((p) => {
            cachePoliticasRoles[p.rol] = p;
        });

        // Poblar formulario Nivel 1
        const pol1 = cachePoliticasRoles["nivel_1"];
        if (pol1) {
            const inpT1 = document.querySelector("#pol-tiempo-nivel1");
            const selV1 = document.querySelector("#pol-vel-nivel1");
            const chkE1 = document.querySelector("#pol-exento-nivel1");
            const chkR1 = document.querySelector("#pol-reacceso-nivel1");

            if (inpT1) inpT1.value = pol1.tiempo_defecto_minutos !== null ? pol1.tiempo_defecto_minutos : 120;
            if (selV1) selV1.value = String(pol1.velocidad_defecto_mbps ?? 10);
            if (chkE1) chkE1.checked = !!pol1.exento_filtro_defecto;
            if (chkR1) chkR1.checked = pol1.permite_reacceso !== false;
        }

        // Poblar formulario Nivel 2
        const pol2 = cachePoliticasRoles["nivel_2"];
        if (pol2) {
            const inpT2 = document.querySelector("#pol-tiempo-nivel2");
            const selV2 = document.querySelector("#pol-vel-nivel2");
            const chkE2 = document.querySelector("#pol-exento-nivel2");
            const chkR2 = document.querySelector("#pol-reacceso-nivel2");

            if (inpT2) inpT2.value = pol2.tiempo_defecto_minutos !== null ? pol2.tiempo_defecto_minutos : 0;
            if (selV2) selV2.value = String(pol2.velocidad_defecto_mbps ?? 0);
            if (chkE2) chkE2.checked = !!pol2.exento_filtro_defecto;
            if (chkR2) chkR2.checked = pol2.permite_reacceso !== false;
        }
    } catch (e) {
        console.error("Error al cargar políticas de roles:", e);
    }
}

// Event Listeners para guardar políticas
const formPol1 = document.querySelector("#form-politica-nivel1");
if (formPol1) {
    formPol1.addEventListener("submit", async (e) => {
        e.preventDefault();
        const inpT1 = document.querySelector("#pol-tiempo-nivel1");
        const selV1 = document.querySelector("#pol-vel-nivel1");
        const chkE1 = document.querySelector("#pol-exento-nivel1");
        const chkR1 = document.querySelector("#pol-reacceso-nivel1");

        const data = {
            tiempo_defecto_minutos: inpT1 ? parseInt(inpT1.value) || 0 : 0,
            velocidad_defecto_mbps: selV1 ? parseInt(selV1.value) || 0 : 0,
            exento_filtro_defecto: chkE1 ? chkE1.checked : false,
            permite_reacceso: chkR1 ? chkR1.checked : true
        };

        try {
            const res = await fetch(`${API_URL}/roles/policies/nivel_1`, {
                method: "PUT",
                headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                const resJson = await res.json();
                cachePoliticasRoles["nivel_1"] = resJson.politica;
                mostrarToast("✓ Política de Nivel 1 guardada correctamente");
            } else {
                mostrarToast("Error al guardar política de Nivel 1", true);
            }
        } catch (err) {
            console.error(err);
            mostrarToast("Error de conexión al guardar", true);
        }
    });
}

const formPol2 = document.querySelector("#form-politica-nivel2");
if (formPol2) {
    formPol2.addEventListener("submit", async (e) => {
        e.preventDefault();
        const inpT2 = document.querySelector("#pol-tiempo-nivel2");
        const selV2 = document.querySelector("#pol-vel-nivel2");
        const chkE2 = document.querySelector("#pol-exento-nivel2");
        const chkR2 = document.querySelector("#pol-reacceso-nivel2");

        const data = {
            tiempo_defecto_minutos: inpT2 ? parseInt(inpT2.value) || 0 : 0,
            velocidad_defecto_mbps: selV2 ? parseInt(selV2.value) || 0 : 0,
            exento_filtro_defecto: chkE2 ? chkE2.checked : true,
            permite_reacceso: chkR2 ? chkR2.checked : true
        };

        try {
            const res = await fetch(`${API_URL}/roles/policies/nivel_2`, {
                method: "PUT",
                headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                const resJson = await res.json();
                cachePoliticasRoles["nivel_2"] = resJson.politica;
                mostrarToast("✓ Política de Nivel 2 guardada correctamente");
            } else {
                mostrarToast("Error al guardar política de Nivel 2", true);
            }
        } catch (err) {
            console.error(err);
            mostrarToast("Error de conexión al guardar", true);
        }
    });
}

// ============================================================
// MÓDULO: MATERIALES Y ARCHIVOS COMPARTIDOS
// ============================================================
function formatearTamanoBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function obtenerIconoArchivo(nombre) {
    const ext = (nombre || "").split(".").pop().toLowerCase();
    if (["pdf"].includes(ext)) return "📄";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "📦";
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "🖼️";
    if (["doc", "docx", "odt"].includes(ext)) return "📝";
    if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
    if (["txt", "md"].includes(ext)) return "📋";
    if (["exe", "sh", "deb", "bin"].includes(ext)) return "⚙️";
    return "📁";
}

async function cargarArchivos() {
    const tabla = document.querySelector("#tabla-archivos tbody");
    const mensaje = document.querySelector("#mensaje-archivos");
    if (!tabla) return;

    try {
        const res = await fetch(`${API_URL}/files/`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const archivos = await res.json();

        if (archivos.length === 0) {
            tabla.style.opacity = "0.4";
            setTimeout(() => { tabla.innerHTML = ""; tabla.style.opacity = ""; }, 200);
            if (mensaje) mensaje.textContent = "No hay archivos subidos todavía.";
            return;
        }

        if (mensaje) mensaje.textContent = "";
        const fragmento = document.createDocumentFragment();

        archivos.forEach((a) => {
            const tr = document.createElement("tr");
            const icono = obtenerIconoArchivo(a.nombre_original);
            let badgeAlcance = '<span class="badge badge-alcance-todos">🌐 Toda la Red</span>';
            if (a.alcance === "nivel_1") {
                badgeAlcance = '<span class="badge badge-alcance-nivel1">👥 Nivel 1</span>';
            } else if (a.alcance === "nivel_2") {
                badgeAlcance = '<span class="badge badge-alcance-nivel2">👥 Nivel 2</span>';
            }

            const ext = a.nombre_original.split('.').pop().toUpperCase();
            tr.innerHTML = `
                <td>
                    <div class="file-row-name">
                        <span class="file-icon-wrap">${icono}</span>
                        <div class="file-name-info">
                            <strong class="file-name-text">${a.nombre_original}</strong>
                            <span class="file-ext-badge">${ext}</span>
                        </div>
                    </div>
                </td>
                <td class="td-secondary">${a.descripcion || '<span class="dim">—</span>'}</td>
                <td><span class="badge badge-qos">${formatearTamanoBytes(a.tamano_bytes)}</span></td>
                <td>${badgeAlcance}</td>
                <td class="td-secondary td-mono">${formatearFecha(a.fecha_subida)}</td>
                <td>
                    <div class="td-actions">
                        <a href="${API_URL}/files/${a.id}/download" class="btn btn-download" target="_blank">
                            ⬇ Descargar
                        </a>
                        <button class="btn btn-delete-icon btn-eliminar-archivo" data-id="${a.id}" title="Eliminar archivo">
                            🗑
                        </button>
                    </div>
                </td>
            `;
            fragmento.appendChild(tr);
        });

        // Fade-out, swap, fade-in — sin parpadeo brusco
        tabla.style.transition = "opacity 0.18s ease";
        tabla.style.opacity = "0";
        setTimeout(() => {
            tabla.replaceChildren(fragmento);
            tabla.style.opacity = "1";
        }, 180);
    } catch (e) {
        console.error("Error al cargar archivos:", e);
    }
}

// Subir archivo y UI de Dropzone
const formSubirArchivo = document.querySelector("#form-subir-archivo");
const inputFilesUpload = document.querySelector("#input-archivo-file");
const dropzoneArchivoEl = document.querySelector("#dropzone-archivo");
const uploadFilenameDisp = document.querySelector("#upload-filename-display");

function actualizarDropzoneVisual() {
    if (!uploadFilenameDisp) return;
    if (inputFilesUpload && inputFilesUpload.files && inputFilesUpload.files.length > 0) {
        const f = inputFilesUpload.files[0];
        const sizeMb = (f.size / (1024 * 1024)).toFixed(2);
        uploadFilenameDisp.textContent = `${f.name} (${sizeMb} MB)`;
        if (dropzoneArchivoEl) dropzoneArchivoEl.classList.add("has-file");
    } else {
        uploadFilenameDisp.textContent = "Ningún archivo seleccionado";
        if (dropzoneArchivoEl) dropzoneArchivoEl.classList.remove("has-file");
    }
}

if (inputFilesUpload) {
    inputFilesUpload.addEventListener("change", actualizarDropzoneVisual);
}

if (dropzoneArchivoEl && inputFilesUpload) {
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzoneArchivoEl.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzoneArchivoEl.classList.add("dragover");
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzoneArchivoEl.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzoneArchivoEl.classList.remove("dragover");
        }, false);
    });

    dropzoneArchivoEl.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
            inputFilesUpload.files = dt.files;
            actualizarDropzoneVisual();
        }
    }, false);
}

if (formSubirArchivo) {
    formSubirArchivo.addEventListener("reset", () => {
        setTimeout(actualizarDropzoneVisual, 10);
    });

    formSubirArchivo.addEventListener("submit", async (e) => {
        e.preventDefault();
        const inputFiles = document.querySelector("#input-archivo-file");
        const inputDesc = document.querySelector("#input-archivo-desc");
        const selectAlcance = document.querySelector("#select-archivo-alcance");
        const btnSubmit = document.querySelector("#btn-submit-archivo");

        if (!inputFiles || !inputFiles.files || inputFiles.files.length === 0) {
            mostrarToast("Por favor selecciona un archivo para subir", true);
            return;
        }

        const file = inputFiles.files[0];
        if (file.size > 50 * 1024 * 1024) {
            mostrarToast("El archivo excede el límite máximo de 50 MB", true);
            return;
        }

        btnSubmit.disabled = true;
        btnSubmit.textContent = "⏳ Subiendo archivo...";

        const reader = new FileReader();
        reader.onload = async () => {
            const base64Content = reader.result;
            const payload = {
                nombre_original: file.name,
                contenido_base64: base64Content,
                descripcion: inputDesc ? inputDesc.value.trim() : "",
                alcance: selectAlcance ? selectAlcance.value : "todos",
                tipo_mime: file.type || "application/octet-stream"
            };

            try {
                const res = await fetch(`${API_URL}/files/upload`, {
                    method: "POST",
                    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    mostrarToast("✓ Archivo subido y compartido en la red");
                    formSubirArchivo.reset();
                    actualizarDropzoneVisual();
                    await cargarArchivos();
                } else {
                    const err = await res.json();
                    mostrarToast(err.detail || "Error al subir archivo", true);
                }
            } catch (err) {
                console.error(err);
                mostrarToast("Error de conexión al subir archivo", true);
            } finally {
                btnSubmit.disabled = false;
                btnSubmit.textContent = "📤 Compartir en Red";
            }
        };
        reader.readAsDataURL(file);
    });
}

// Eliminar archivo
const elTablaArchivos = document.querySelector("#tabla-archivos");
if (elTablaArchivos) {
    elTablaArchivos.addEventListener("click", async (e) => {
        const btn = e.target.closest(".btn-eliminar-archivo");
        if (!btn) return;
        const id = btn.dataset.id;
        if (!confirm("¿Seguro que deseas eliminar este archivo del servidor?")) return;

        try {
            const res = await fetch(`${API_URL}/files/${id}`, {
                method: "DELETE",
                headers: getAuthHeaders()
            });
            if (res.ok) {
                mostrarToast("✓ Archivo eliminado");
                cargarArchivos();
            } else {
                mostrarToast("Error al eliminar archivo", true);
            }
        } catch (e) {
            console.error(e);
            mostrarToast("Error de conexión", true);
        }
    });
}

// ============================================================
// MÓDULO: MENSAJERÍA Y NOTIFICACIONES EN RED
// ============================================================
function poblarSelectDispositivosMensaje() {
    const sel = document.querySelector("#select-mensaje-dispositivo");
    if (!sel) return;
    sel.innerHTML = "";
    cacheDispositivos.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.dataset.ip = d.direccion_ip || "";
        opt.textContent = `${d.nombre_host || "Equipo"} (${d.direccion_ip || d.direccion_mac || "ID " + d.id})`;
        sel.appendChild(opt);
    });
}

const selAlcanceMsg = document.querySelector("#select-mensaje-alcance");
if (selAlcanceMsg) {
    selAlcanceMsg.addEventListener("change", () => {
        const grupoDev = document.querySelector("#grupo-mensaje-dispositivo");
        if (grupoDev) {
            grupoDev.style.display = selAlcanceMsg.value === "dispositivo" ? "block" : "none";
        }
    });
}

async function cargarMensajes() {
    const tabla = document.querySelector("#tabla-mensajes tbody");
    const mensaje = document.querySelector("#mensaje-mensajes");
    if (!tabla) return;

    try {
        const res = await fetch(`${API_URL}/messages/`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const mensajes = await res.json();

        if (mensajes.length === 0) {
            tabla.style.opacity = "0.4";
            setTimeout(() => { tabla.innerHTML = ""; tabla.style.opacity = ""; }, 200);
            if (mensaje) mensaje.textContent = "No hay comunicados registrados.";
            return;
        }

        if (mensaje) mensaje.textContent = "";
        const fragmento = document.createDocumentFragment();

        mensajes.forEach((m) => {
            const tr = document.createElement("tr");

            let badgeTipo = '<span class="badge badge-alcance-nivel1">ℹ️ Informativo</span>';
            if (m.tipo === "aviso") {
                badgeTipo = '<span class="badge badge-pending">⚠️ Aviso</span>';
            } else if (m.tipo === "urgente") {
                badgeTipo = '<span class="badge badge-rejected">🚨 Urgente</span>';
            }

            let badgeAlcance = '<span class="badge badge-alcance-todos">🌐 Toda la red</span>';
            if (m.alcance === "nivel_1") badgeAlcance = '<span class="badge badge-alcance-nivel1">👥 Solo Nivel 1</span>';
            else if (m.alcance === "nivel_2") badgeAlcance = '<span class="badge badge-alcance-nivel2">👥 Solo Nivel 2</span>';
            else if (m.alcance === "dispositivo") badgeAlcance = `<span class="badge badge-qos">🎯 PC (${m.direccion_ip || "específica"})</span>`;

            tr.innerHTML = `
                <td class="td-secondary td-mono">${formatearFecha(m.creado_en)}</td>
                <td>${badgeTipo}</td>
                <td>${badgeAlcance}</td>
                <td>
                    <strong class="msg-title">${m.titulo}</strong>
                    <span class="msg-body">${m.contenido}</span>
                </td>
                <td>
                    ${m.activo 
                        ? '<span class="badge badge-online">● Activo</span>' 
                        : '<span class="badge badge-offline">Retirado</span>'}
                </td>
                <td>
                    ${m.activo ? `
                        <button class="btn btn-rechazar btn-sm btn-desactivar-mensaje" data-id="${m.id}">Retirar</button>
                    ` : '<span class="dim">—</span>'}
                </td>
            `;
            fragmento.appendChild(tr);
        });

        // Fade-out suave, swap, fade-in — sin parpadeo brusco
        tabla.style.transition = "opacity 0.18s ease";
        tabla.style.opacity = "0";
        setTimeout(() => {
            tabla.replaceChildren(fragmento);
            tabla.style.opacity = "1";
        }, 180);
    } catch (e) {
        console.error("Error al cargar mensajes:", e);
    }
}

// Enviar comunicado
const formEnviarMensaje = document.querySelector("#form-enviar-mensaje");
if (formEnviarMensaje) {
    formEnviarMensaje.addEventListener("submit", async (e) => {
        e.preventDefault();
        const inpTitulo = document.querySelector("#input-mensaje-titulo");
        const selTipo = document.querySelector("#select-mensaje-tipo");
        const selAlcance = document.querySelector("#select-mensaje-alcance");
        const selDev = document.querySelector("#select-mensaje-dispositivo");
        const txtContenido = document.querySelector("#input-mensaje-contenido");

        if (!inpTitulo.value.trim() || !txtContenido.value.trim()) return;

        let devId = null;
        let devIp = null;
        if (selAlcance.value === "dispositivo" && selDev && selDev.selectedOptions[0]) {
            devId = parseInt(selDev.value);
            devIp = selDev.selectedOptions[0].dataset.ip || null;
        }

        const data = {
            titulo: inpTitulo.value.trim(),
            contenido: txtContenido.value.trim(),
            tipo: selTipo.value,
            alcance: selAlcance.value,
            dispositivo_id: devId,
            direccion_ip: devIp
        };

        try {
            const res = await fetch(`${API_URL}/messages/`, {
                method: "POST",
                headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                mostrarToast("📢 Comunicado transmitido a la red");
                formEnviarMensaje.reset();
                if (document.querySelector("#grupo-mensaje-dispositivo")) {
                    document.querySelector("#grupo-mensaje-dispositivo").style.display = "none";
                }
                await cargarMensajes();
            } else {
                mostrarToast("Error enviando comunicado", true);
            }
        } catch (err) {
            console.error(err);
            mostrarToast("Error de conexión", true);
        }
    });
}

// Desactivar comunicado
const elTablaMensajes = document.querySelector("#tabla-mensajes");
if (elTablaMensajes) {
    elTablaMensajes.addEventListener("click", async (e) => {
        const btn = e.target.closest(".btn-desactivar-mensaje");
        if (!btn) return;
        const id = btn.dataset.id;
        try {
            const res = await fetch(`${API_URL}/messages/${id}`, {
                method: "DELETE",
                headers: getAuthHeaders()
            });
            if (res.ok) {
                mostrarToast("✓ Comunicado retirado de pantallas");
                cargarMensajes();
            }
        } catch (e) {
            console.error(e);
        }
    });
}

// ── Estado de MikroTik y Auto-Sincronización ──
let mikrotikEstadoConectado = null;

async function verificarEstadoMikrotik() {
    const badge = document.querySelector("#mikrotik-status-badge");
    const textEl = document.querySelector("#mikrotik-status-text");
    if (!badge || !textEl) return;

    try {
        const res = await fetch(`${API_URL}/router/status`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error("HTTP error " + res.status);
        const data = await res.json();

        if (data.conectado) {
            badge.className = "mikrotik-status-badge mikrotik-online";
            textEl.textContent = `MikroTik: Online (${data.host})`;
            badge.title = `Router MikroTik conectado y respondiendo por API RouterOS (${data.host}:${data.puerto})`;

            // Si el router acaba de conectarse tras estar offline, auto-sincronizar equipos automáticamente
            if (mikrotikEstadoConectado === false) {
                mostrarToast("✓ Router MikroTik conectado. Sincronizando equipos automáticamente...");
                sincronizarDispositivosSilencioso();
            }
            mikrotikEstadoConectado = true;
        } else {
            badge.className = "mikrotik-status-badge mikrotik-offline";
            textEl.textContent = "MikroTik: Desconectado";
            badge.title = data.error || `Sin enlace con router MikroTik (${data.host}:${data.puerto})`;
            mikrotikEstadoConectado = false;
        }
    } catch (e) {
        badge.className = "mikrotik-status-badge mikrotik-offline";
        textEl.textContent = "MikroTik: Desconectado";
        badge.title = "No se puede consultar el estado del router MikroTik";
        mikrotikEstadoConectado = false;
    }
}

async function sincronizarDispositivosSilencioso() {
    try {
        await fetch(`${API_URL}/devices/sync`, { method: "POST", headers: getAuthHeaders() });
        await cargarDispositivos();
    } catch (e) {
        // silencioso
    }
}

// Carga inicial y actualización periódica
verificarEstadoMikrotik();
cargarDispositivos();
cargarSesionesActivas();
cargarDominiosBloqueados();
cargarUsuarios();
cargarPoliticasRoles();
cargarArchivos();
cargarMensajes();

setInterval(() => {
    verificarEstadoMikrotik();
    cargarDispositivos();
    cargarSesionesActivas();
    cargarDominiosBloqueados();
}, 10000);

