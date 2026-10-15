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
let cacheDominiosList = [];

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

// --- Sistema de Pestañas Principales (Tabs) y Menú Desplegable ---
const MODULOS_MAP = {
    "tab-control": { icon: "🖥️", title: "Dispositivos y Sesiones" },
    "tab-filtrado": { icon: "🛡️", title: "Filtrado Web" },
    "tab-estadisticas": { icon: "📊", title: "Estadísticas y Gráficos" },
    "tab-actividad": { icon: "🎮", title: "Historial de Actividad" },
    "tab-grupos": { icon: "👥", title: "Grupos y Aislamiento" },
    "tab-archivos": { icon: "📁", title: "Gestión de Archivos" },
    "tab-mensajes": { icon: "💬", title: "Mensajería" },
    "tab-usuarios": { icon: "👤", title: "Gestión de Usuarios" },
    "tab-roles": { icon: "⚙️", title: "Permisos y Roles" }
};

function activarPestana(targetId) {
    if (!targetId) return;

    // 1. Activar botón de pestaña correspondiente
    const btnActivo = document.querySelector(`.tab-btn[data-tab="${targetId}"]`);
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    if (btnActivo) {
        btnActivo.classList.add("active");
    }

    // 2. Sincronizar indicador de módulo actual en la barra superior
    const modInfo = MODULOS_MAP[targetId];
    if (modInfo) {
        const iconEl = document.getElementById("current-module-icon");
        const titleEl = document.getElementById("current-module-title");
        if (iconEl) iconEl.textContent = modInfo.icon;
        if (titleEl) titleEl.textContent = modInfo.title;
    }

    // 3. Sincronizar el Menú Desplegable Rápido
    const selectNav = document.getElementById("select-tab-nav");
    if (selectNav && selectNav.value !== targetId) {
        selectNav.value = targetId;
    }

    // 4. Cerrar menú desplegable de módulos tras la selección
    cerrarMenuModulos();

    // 5. Mostrar el contenido de la pestaña seleccionada
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    const targetContent = document.getElementById(targetId);
    if (targetContent) {
        targetContent.classList.add("active");
    }

    // 6. Cargar los datos específicos del módulo
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
    } else if (targetId === "tab-actividad") {
        cargarActividadDispositivos();
    } else if (targetId === "tab-grupos") {
        cargarModuloGrupos();
    }
}

// --- Control del Menú Desplegable de Usuario (Topbar) ---
const elUserMenuWrap = document.getElementById("user-menu-wrap");
const elBtnUserDropdown = document.getElementById("btn-user-dropdown-toggle");
const elUserDropdownPanel = document.getElementById("user-dropdown-panel");

function toggleMenuUsuario(forzarCierre) {
    if (!elUserDropdownPanel) return;
    const estaAbierto = elUserDropdownPanel.classList.contains("show");
    if (forzarCierre || estaAbierto) {
        elUserDropdownPanel.classList.remove("show");
        if (elUserMenuWrap) elUserMenuWrap.classList.remove("open");
        if (elBtnUserDropdown) elBtnUserDropdown.setAttribute("aria-expanded", "false");
    } else {
        elUserDropdownPanel.classList.add("show");
        if (elUserMenuWrap) elUserMenuWrap.classList.add("open");
        if (elBtnUserDropdown) elBtnUserDropdown.setAttribute("aria-expanded", "true");
        cerrarMenuModulos();
    }
}

function cerrarMenuUsuario() {
    toggleMenuUsuario(true);
}

if (elBtnUserDropdown) {
    elBtnUserDropdown.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMenuUsuario();
    });
}

// --- Control del Menú Desplegable de Módulos (Catálogo Hamburguesa) ---
const elModulesMenuWrap = document.getElementById("modules-menu-wrap");
const elBtnModulesToggle = document.getElementById("btn-modules-toggle");
const elModulesDropdownPanel = document.getElementById("modules-dropdown-panel");
const elBtnCloseModules = document.getElementById("btn-close-modules-menu");

function toggleMenuModulos(forzarCierre) {
    if (!elModulesDropdownPanel) return;
    const estaAbierto = elModulesDropdownPanel.classList.contains("show");
    if (forzarCierre || estaAbierto) {
        elModulesDropdownPanel.classList.remove("show");
        if (elModulesMenuWrap) elModulesMenuWrap.classList.remove("open");
        if (elBtnModulesToggle) elBtnModulesToggle.setAttribute("aria-expanded", "false");
    } else {
        elModulesDropdownPanel.classList.add("show");
        if (elModulesMenuWrap) elModulesMenuWrap.classList.add("open");
        if (elBtnModulesToggle) elBtnModulesToggle.setAttribute("aria-expanded", "true");
        cerrarMenuUsuario();
    }
}

function cerrarMenuModulos() {
    if (elModulesDropdownPanel && elModulesDropdownPanel.classList.contains("show")) {
        elModulesDropdownPanel.classList.remove("show");
        if (elModulesMenuWrap) elModulesMenuWrap.classList.remove("open");
        if (elBtnModulesToggle) elBtnModulesToggle.setAttribute("aria-expanded", "false");
    }
}

if (elBtnModulesToggle) {
    elBtnModulesToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMenuModulos();
    });
}

if (elBtnCloseModules) {
    elBtnCloseModules.addEventListener("click", (e) => {
        e.stopPropagation();
        cerrarMenuModulos();
    });
}

// Cerrar menús al hacer clic fuera o presionar Escape
document.addEventListener("click", (e) => {
    if (elUserMenuWrap && !elUserMenuWrap.contains(e.target)) {
        cerrarMenuUsuario();
    }
    if (elModulesMenuWrap && !elModulesMenuWrap.contains(e.target)) {
        cerrarMenuModulos();
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        cerrarMenuUsuario();
        cerrarMenuModulos();
    }
});

// Escuchar clics en los botones de pestañas
document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        activarPestana(btn.dataset.tab);
    });
});

// Escuchar cambios en el selector desplegable rápido
const elSelectTabNav = document.getElementById("select-tab-nav");
if (elSelectTabNav) {
    elSelectTabNav.addEventListener("change", (e) => {
        activarPestana(e.target.value);
    });
}

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
        const totalPending = cacheDispositivos.filter((d) => d.estado === "pendiente" || d.estado === "pending").length;
        const totalAll = cacheDispositivos.length;

        // Detección proactiva de nuevos dispositivos en cualquier módulo (en línea o pendientes de aprobación)
        const candidatosAlerta = cacheDispositivos.filter((d) => (d.en_linea === true || d.estado === "pendiente" || d.estado === "pending") && !d.es_admin);
        const macsActuales = new Set(candidatosAlerta.map((d) => (d.direccion_mac || "").toUpperCase()));

        if (macsConectadasPrevias !== null) {
            for (const dev of candidatosAlerta) {
                const m = (dev.direccion_mac || "").toUpperCase();
                if (m && !macsConectadasPrevias.has(m)) {
                    // ¡Alerta global con sonido de nuevo dispositivo conectado!
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
        // En Pendientes mostrar todas las solicitudes de equipos pendientes de aprobación
        lista = cacheDispositivos.filter((d) => d.estado === "pendiente" || d.estado === "pending");
        mensajeVacio = "No hay solicitudes pendientes en este momento.";
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
        cacheDominiosList = dominios;

        elTablaDominios.innerHTML = dominios.map((d) => {
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

            return `
              <tr data-id="${d.id}">
                <td><strong>${escapeHtml(dom)}</strong></td>
                <td><span class="badge badge-category">${escapeHtml(cat)}</span></td>
                <td>${badgeAlcance}</td>
                <td>${formatearFecha(fecha)}</td>
                <td><span class="badge badge-dns-active" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35);">🟢 Autorizado en MikroTik</span></td>
                <td>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <button class="btn btn-editar-dominio" data-id="${d.id}" data-accion="edit-domain" style="background: rgba(0, 229, 255, 0.12); color: #00E5FF; border: 1px solid rgba(0, 229, 255, 0.3); padding: 5px 10px; font-size: 0.78rem;">
                      ✏️ Editar
                    </button>
                    <button class="btn btn-desbloquear" data-id="${d.id}" data-accion="unblock-domain" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 5px 10px; font-size: 0.78rem;">
                      Revocar
                    </button>
                  </div>
                </td>
              </tr>
            `;
        }).join("");
    } catch (error) {
        console.error("Error cargando dominios de lista blanca:", error);
    }
}

async function bloquearDominio(dominio, categoria = "Educación / Estudio", alcance = "todos", dispositivosIds = []) {
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
            alert(err.detail || "Error al autorizar dominio");
            return;
        }
        mostrarToast(`✓ Dominio ${dominio} añadido a la Lista Blanca`);
        await cargarDominiosBloqueados();
        await cargarEstadisticas();
    } catch (error) {
        console.error("Error al autorizar dominio:", error);
    }
}

async function desbloquearDominio(domainId) {
    try {
        await fetch(`${API_URL}/filter/domains/${domainId}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        });
        mostrarToast("✓ Dominio revocado de la Lista Blanca");
        await cargarDominiosBloqueados();
        await cargarEstadisticas();
    } catch (error) {
        console.error("Error al revocar dominio:", error);
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
        if (elKpiHoras) elKpiHoras.textContent = resumen.sesiones.horas_hoy_formato || `${resumen.sesiones.horas_hoy || 0} h`;
        const kpiHorasSub = document.querySelector("#kpi-horas-sub");
        if (kpiHorasSub && resumen.sesiones.tiempo_muerto_hoy !== undefined) {
            kpiHorasSub.textContent = `Hoy (${resumen.sesiones.tiempo_muerto_hoy}h pausas) • Total: ${resumen.sesiones.horas_totales}h acumuladas`;
        }
        if (elKpiDominios) elKpiDominios.textContent = resumen.dominios_bloqueados;

        const elKpiMikrotikUptime = document.querySelector("#kpi-mikrotik-uptime");
        const elKpiMikrotikSub = document.querySelector("#kpi-mikrotik-sub");
        if (elKpiMikrotikUptime) {
            if (resumen.mikrotik && resumen.mikrotik.conectado) {
                elKpiMikrotikUptime.textContent = resumen.mikrotik.uptime || "Online";
                if (elKpiMikrotikSub) {
                    elKpiMikrotikSub.textContent = `CPU: ${resumen.mikrotik.cpu_load || '0%'} • ${resumen.mikrotik.board_name || 'MikroTik'}`;
                }
            } else {
                elKpiMikrotikUptime.textContent = "Desconectado";
                if (elKpiMikrotikSub) elKpiMikrotikSub.textContent = "Sin enlace con router";
            }
        }

        // 2. Consumo por Equipos (Desglose individual y gráficos)
        const resConsumo = await fetch(`${API_URL}/stats/consumo-equipos`, { headers: getAuthHeaders() });
        const consumoEquipos = await resConsumo.json();
        cacheConsumoEquipos = Array.isArray(consumoEquipos) ? consumoEquipos : [];
        
        renderizarGraficoConsumo(cacheConsumoEquipos);
        renderizarEstadisticasIndividuales(cacheConsumoEquipos);

        // 3. Distribución de Categorías (Gráfico de Dona)
        const resCat = await fetch(`${API_URL}/stats/distribucion-categorias`, { headers: getAuthHeaders() });
        const categorias = await resCat.json();
        renderizarGraficoCategorias(categorias);
    } catch (error) {
        console.error("Error al cargar estadísticas:", error);
    }
}

let cacheConsumoEquipos = [];
let modoChartConsumo = "activo";

function configurarControlesEstadisticas() {
    const btnSoloActivo = document.getElementById("btn-chart-solo-activo");
    const btnComparativo = document.getElementById("btn-chart-comparativo");

    if (btnSoloActivo && btnComparativo) {
        btnSoloActivo.addEventListener("click", () => {
            modoChartConsumo = "activo";
            btnSoloActivo.classList.add("active");
            btnComparativo.classList.remove("active");
            renderizarGraficoConsumo(cacheConsumoEquipos);
        });

        btnComparativo.addEventListener("click", () => {
            modoChartConsumo = "comparativo";
            btnComparativo.classList.add("active");
            btnSoloActivo.classList.remove("active");
            renderizarGraficoConsumo(cacheConsumoEquipos);
        });
    }

    const filtroInput = document.getElementById("filtro-stats-dispositivo");
    if (filtroInput) {
        filtroInput.addEventListener("input", () => {
            const term = filtroInput.value.toLowerCase().trim();
            const filtrados = cacheConsumoEquipos.filter((d) =>
                (d.nombre && d.nombre.toLowerCase().includes(term)) ||
                (d.ip && d.ip.toLowerCase().includes(term)) ||
                (d.mac && d.mac.toLowerCase().includes(term)) ||
                (d.rol && d.rol.toLowerCase().includes(term))
            );
            renderizarEstadisticasIndividuales(filtrados);
        });
    }
}

// Configurar al cargar script
setTimeout(configurarControlesEstadisticas, 300);

function renderizarGraficoConsumo(datos) {
    const ctx = document.getElementById("chart-consumo");
    if (!ctx) return;

    const labels = datos.map((d) => d.nombre);
    const horasActivas = datos.map((d) => d.horas_conectado);
    const horasMuertas = datos.map((d) => +(d.minutos_muerto / 60).toFixed(2));

    if (chartConsumoInstance) {
        chartConsumoInstance.destroy();
    }

    let datasets = [];
    if (modoChartConsumo === "activo") {
        datasets = [
            {
                label: "Tiempo Activo Real (Horas)",
                data: horasActivas.length > 0 ? horasActivas : [0],
                backgroundColor: "rgba(0, 229, 255, 0.85)",
                borderColor: "#00E5FF",
                borderWidth: 2,
                borderRadius: 8,
                barThickness: 32,
            }
        ];
    } else {
        datasets = [
            {
                label: "Tiempo Activo Real (h)",
                data: horasActivas.length > 0 ? horasActivas : [0],
                backgroundColor: "rgba(0, 229, 255, 0.85)",
                borderColor: "#00E5FF",
                borderWidth: 1.5,
                borderRadius: 6,
            },
            {
                label: "Tiempo Muerto Descartado (h)",
                data: horasMuertas.length > 0 ? horasMuertas : [0],
                backgroundColor: "rgba(148, 163, 184, 0.3)",
                borderColor: "rgba(148, 163, 184, 0.6)",
                borderWidth: 1.5,
                borderRadius: 6,
            },
        ];
    }

        const esLight = document.documentElement.getAttribute("data-theme") === "light";
        const colorTextoChart = esLight ? "#334155" : "#94A3B8";
        const colorGridChart = esLight ? "rgba(203, 213, 225, 0.6)" : "rgba(255, 255, 255, 0.05)";

        chartConsumoInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels.length > 0 ? labels : ["Sin datos"],
            datasets: datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: { color: colorTextoChart, font: { family: "Inter", size: 11 } }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const index = context.dataIndex;
                            const item = datos[index];
                            if (context.datasetIndex === 0 && item) {
                                return `Activo Real: ${item.tiempo_activo_formato || item.horas_conectado + 'h'}`;
                            } else if (context.datasetIndex === 1 && item) {
                                return `Tiempo Muerto: ${item.tiempo_muerto_formato || item.horas_muerto + 'h'}`;
                            }
                            return `${context.dataset.label}: ${context.raw}`;
                        },
                        footer: function(tooltipItems) {
                            const index = tooltipItems[0].dataIndex;
                            const item = datos[index];
                            if (item && item.porcentaje_actividad !== undefined) {
                                return `Aprovechamiento: ${item.porcentaje_actividad}% productivo`;
                            }
                            return "";
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: colorTextoChart, font: { family: "Inter", size: 11 } },
                    grid: { color: colorGridChart },
                },
                x: {
                    ticks: { color: colorTextoChart, font: { family: "Inter", size: 11 } },
                    grid: { display: false },
                },
            },
        },
    });
}

function renderizarEstadisticasIndividuales(datos) {
    const contadorBadge = document.getElementById("contador-dispositivos-stats");
    if (contadorBadge) {
        contadorBadge.textContent = `${datos.length} equipo${datos.length === 1 ? '' : 's'}`;
    }

    const grid = document.getElementById("grid-stats-dispositivos");
    const tbody = document.getElementById("tbody-stats-individual");

    if (!grid || !tbody) return;

    if (datos.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; color: var(--color-texto-suave); padding: 36px;">
                No se encontraron dispositivos que coincidan con la búsqueda.
            </div>
        `;
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align: center; color: var(--color-texto-suave); padding: 24px;">
                    No hay equipos para mostrar.
                </td>
            </tr>
        `;
        return;
    }

    // 1. Renderizar Cuadrícula de Tarjetas
    grid.innerHTML = "";
    datos.forEach((item) => {
        const esAdmin = item.rol === "admin" || (item.mac && item.mac.toUpperCase() === "48:E7:DA:0B:CB:27");
        const rolClase = esAdmin ? "role-admin" : (item.rol === "nivel_2" ? "role-nivel2" : "role-nivel1");
        const rolTexto = esAdmin ? "👑 ADMIN" : (item.rol === "nivel_2" ? "👨‍🏫 NIVEL 2" : "🎓 NIVEL 1");
        
        const esCelular = item.nombre && (item.nombre.toLowerCase().includes("android") || item.nombre.toLowerCase().includes("iphone") || item.nombre.toLowerCase().includes("galaxy") || item.nombre.toLowerCase().includes("xiaomi") || item.nombre.toLowerCase().includes("celular"));
        const iconoEquipo = esCelular ? "📱" : (esAdmin ? "🖥️" : "💻");

        const estadoBadge = item.esta_en_linea
            ? `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #86EFAC; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.72rem; padding: 2px 8px;">🟢 En Línea</span>`
            : `<span class="badge" style="background: rgba(148, 163, 184, 0.1); color: #94A3B8; border: 1px solid rgba(148, 163, 184, 0.2); font-size: 0.72rem; padding: 2px 8px;">⚪ Inactivo</span>`;

        const card = document.createElement("div");
        card.className = "device-stat-card";
        card.innerHTML = `
            <div class="device-stat-header">
                <div class="device-stat-title">
                    <div class="device-stat-icon">${iconoEquipo}</div>
                    <div>
                        <div class="device-stat-name">${item.nombre}</div>
                        <div class="device-stat-net">${item.ip} • <span style="font-size: 0.73rem; opacity: 0.8;">${item.mac}</span></div>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                    <span class="user-role-badge ${rolClase}" style="font-size: 0.7rem; padding: 2px 8px;">${rolTexto}</span>
                    ${estadoBadge}
                </div>
            </div>

            <div class="device-stat-metrics">
                <div class="stat-metric-box">
                    <span class="stat-metric-label">🟢 Activo Hoy</span>
                    <span class="stat-metric-val-active">${item.tiempo_activo_hoy_formato || '0 min'}</span>
                </div>
                <div class="stat-metric-box">
                    <span class="stat-metric-label">📚 Total Histórico</span>
                    <span class="stat-metric-val-idle">${item.tiempo_activo_formato || '0 min'}</span>
                </div>
            </div>

            <div class="stat-progress-wrap">
                <div class="stat-progress-label">
                    <span>Efectividad de Hoy</span>
                    <strong class="stat-progress-pct">${item.porcentaje_actividad_hoy}%</strong>
                </div>
                <div class="stat-progress-bar-bg">
                    <div class="stat-progress-fill" style="width: ${Math.min(100, Math.max(item.porcentaje_actividad_hoy, 4))}%;"></div>
                </div>
                <div style="font-size: 0.72rem; color: var(--color-texto-suave); margin-top: 5px; display: flex; justify-content: space-between;">
                    <span>💤 Pausas hoy: <strong>${item.tiempo_muerto_hoy_formato}</strong></span>
                    <span>${item.sesiones_hoy || 0} sesión(es) hoy</span>
                </div>
            </div>

            <div class="device-stat-footer">
                <span>⚡ QoS: <strong>${item.limite_velocidad_mbps}</strong></span>
                <span>📋 Total histórico: <strong>${item.cantidad_sesiones}</strong> ses.</span>
            </div>
        `;
        grid.appendChild(card);
    });

    // 2. Renderizar Tabla Detallada
    tbody.innerHTML = "";
    datos.forEach((item) => {
        const esAdmin = item.rol === "admin" || (item.mac && item.mac.toUpperCase() === "48:E7:DA:0B:CB:27");
        const rolClase = esAdmin ? "role-admin" : (item.rol === "nivel_2" ? "role-nivel2" : "role-nivel1");
        const rolTexto = esAdmin ? "ADMIN" : (item.rol === "nivel_2" ? "NIVEL 2" : "NIVEL 1");

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <div style="font-weight: 600; color: #F8FAFC;">${item.nombre}</div>
                <small style="color: var(--color-texto-suave);">${item.cantidad_sesiones} sesión(es) acumuladas</small>
            </td>
            <td>
                <div style="font-family: var(--font-mono); font-size: 0.85rem; color: #00E5FF;">${item.ip}</div>
                <div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-texto-suave);">${item.mac}</div>
            </td>
            <td>
                <span class="user-role-badge ${rolClase}" style="font-size: 0.72rem; padding: 2px 8px;">${rolTexto}</span>
            </td>
            <td>
                ${item.esta_en_linea 
                    ? '<span style="color: #86EFAC; font-weight: 600; font-size: 0.82rem;">🟢 En Línea</span>' 
                    : '<span style="color: #94A3B8; font-size: 0.82rem;">⚪ Inactivo</span>'}
            </td>
            <td>
                <strong style="color: #00E5FF; font-family: var(--font-mono); font-size: 0.95rem;">
                    ${item.tiempo_activo_hoy_formato || '0 min'}
                </strong>
                <div style="font-size: 0.72rem; color: var(--color-texto-suave);">${item.sesiones_hoy || 0} sesión(es) hoy</div>
            </td>
            <td>
                <strong style="color: #A5B4FC; font-family: var(--font-mono); font-size: 0.9rem;">
                    ${item.tiempo_activo_formato || '0 min'}
                </strong>
                <div style="font-size: 0.72rem; color: var(--color-texto-suave);">${item.cantidad_sesiones} en total</div>
            </td>
            <td>
                <span style="color: #94A3B8; font-family: var(--font-mono); font-size: 0.85rem;">
                    ${item.tiempo_muerto_hoy_formato || '0 min'}
                </span>
            </td>
            <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="width: 60px; height: 6px; background: rgba(255,255,255,0.08); border-radius: 99px; overflow: hidden;">
                        <div style="width: ${Math.min(100, item.porcentaje_actividad_hoy)}%; height: 100%; background: #00E5FF;"></div>
                    </div>
                    <strong style="font-size: 0.82rem; color: #F1F5F9;">${item.porcentaje_actividad_hoy}%</strong>
                </div>
            </td>
            <td>
                <span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #A5B4FC; border: 1px solid rgba(99, 102, 241, 0.3); font-size: 0.75rem;">
                    ⚡ ${item.limite_velocidad_mbps}
                </span>
            </td>
        `;
        tbody.appendChild(tr);
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

    const esLight = document.documentElement.getAttribute("data-theme") === "light";
    const colorTextoDona = esLight ? "#334155" : "#CBD5E1";
    const borderDona = esLight ? "#FFFFFF" : "#121826";

    chartCategoriasInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: labels.length > 0 ? labels : ["Sin dominios"],
            datasets: [
                {
                    data: cantidades.length > 0 ? cantidades : [1],
                    backgroundColor: coloresDona,
                    hoverBackgroundColor: coloresDona,
                    borderColor: borderDona,
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
                    labels: { color: colorTextoDona, boxWidth: 12, padding: 14, font: { family: "Inter", size: 12, weight: "500" } },
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
    const btnUnblock = evento.target.closest("button[data-accion='unblock-domain']");
    if (btnUnblock) {
        desbloquearDominio(btnUnblock.dataset.id);
        return;
    }
    const btnEdit = evento.target.closest("button[data-accion='edit-domain']");
    if (btnEdit) {
        abrirModalEditarDominio(btnEdit.dataset.id);
        return;
    }
});

// Control del Modal de Edición de Dominio
const modalEditarDom = document.getElementById("modal-editar-dominio");
const btnCerrarEditDom = document.getElementById("btn-cerrar-modal-editar-dominio");
const btnCancEditDom = document.getElementById("btn-cancelar-modal-editar-dominio");
const formEditDom = document.getElementById("form-editar-dominio");

[btnCerrarEditDom, btnCancEditDom].forEach((b) => {
    if (b) {
        b.addEventListener("click", () => {
            if (modalEditarDom) modalEditarDom.style.display = "none";
        });
    }
});

function abrirModalEditarDominio(domainId) {
    const d = cacheDominiosList.find((item) => String(item.id) === String(domainId));
    if (!d || !modalEditarDom) return;

    const inputId = document.getElementById("edit-dominio-id");
    const inputNombre = document.getElementById("edit-dominio-nombre");
    const selectCat = document.getElementById("edit-dominio-categoria");
    const selectAlc = document.getElementById("edit-dominio-alcance");
    const contenedorPcs = document.getElementById("edit-contenedor-pcs");
    const listaPcs = document.getElementById("edit-lista-checkboxes-pcs");

    inputId.value = d.id;
    inputNombre.value = d.dominio || d.domain;
    selectCat.value = d.categoria || d.category || "Educación / Estudio";
    selectAlc.value = d.alcance || "todos";

    // Cargar checkboxes de dispositivos registrados
    if (listaPcs) {
        listaPcs.innerHTML = "";
        const idsSeleccionados = new Set((d.dispositivos_ids || []).map(Number));
        (cacheDispositivos || []).forEach((dev) => {
            const label = document.createElement("label");
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";
            label.style.fontSize = "0.82rem";
            label.style.cursor = "pointer";
            label.style.background = "rgba(255, 255, 255, 0.04)";
            label.style.padding = "5px 9px";
            label.style.borderRadius = "6px";
            label.style.border = "1px solid rgba(255, 255, 255, 0.06)";

            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.className = "chk-edit-pc";
            chk.value = dev.id;
            chk.checked = idsSeleccionados.has(Number(dev.id));

            label.appendChild(chk);
            label.appendChild(document.createTextNode(`${dev.nombre_host || dev.direccion_ip} (${dev.direccion_ip || 'Sin IP'})`));
            listaPcs.appendChild(label);
        });
    }

    const togglePcs = () => {
        if (selectAlc.value === "solo_seleccionados" || selectAlc.value === "todos_excepto") {
            contenedorPcs.style.display = "block";
        } else {
            contenedorPcs.style.display = "none";
        }
    };
    selectAlc.onchange = togglePcs;
    togglePcs();

    modalEditarDom.style.display = "flex";
}

if (formEditDom) {
    formEditDom.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = document.getElementById("edit-dominio-id").value;
        const categoria = document.getElementById("edit-dominio-categoria").value;
        const alcance = document.getElementById("edit-dominio-alcance").value;

        const chks = document.querySelectorAll(".chk-edit-pc:checked");
        const devIds = Array.from(chks).map((c) => parseInt(c.value));

        if ((alcance === "solo_seleccionados" || alcance === "todos_excepto") && devIds.length === 0) {
            alert("Por favor selecciona al menos una computadora de la lista para este alcance.");
            return;
        }

        try {
            const resp = await fetch(`${API_URL}/filter/domains/${id}`, {
                method: "PUT",
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    categoria: categoria,
                    alcance: alcance,
                    dispositivos_ids: devIds,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                alert(err.detail || "Error al actualizar dominio");
                return;
            }
            mostrarToast("✓ Alcance y categoría actualizados en MikroTik");
            if (modalEditarDom) modalEditarDom.style.display = "none";
            await cargarDominiosBloqueados();
            await cargarEstadisticas();
        } catch (error) {
            console.error("Error al actualizar dominio:", error);
        }
    });
}

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

if (elInputDominio) {
    elInputDominio.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (elBtnBloquearDominio) elBtnBloquearDominio.click();
        }
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
// 1. NOTIFICACIÓN HUD RADAR Y AUDIO: NUEVO DISPOSITIVO CONECTADO
// (Aparece y suena en cualquier módulo cuando alguien se conecta al Wi-Fi)
// ============================================================
let timeoutRadarHud = null;
let audioCtxAlertaRed = null;

function reproducirSonidoAlertaRed() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!audioCtxAlertaRed) {
            audioCtxAlertaRed = new AudioContextClass();
        }
        if (audioCtxAlertaRed.state === "suspended") {
            audioCtxAlertaRed.resume();
        }

        const now = audioCtxAlertaRed.currentTime;

        // Tono 1: Onda senoidal suave ascendente (587.33 Hz - D5 a 880 Hz - A5)
        const osc1 = audioCtxAlertaRed.createOscillator();
        const gain1 = audioCtxAlertaRed.createGain();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(587.33, now);
        osc1.frequency.exponentialRampToValueAtTime(880, now + 0.14);

        gain1.gain.setValueAtTime(0.001, now);
        gain1.gain.linearRampToValueAtTime(0.22, now + 0.03);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc1.connect(gain1);
        gain1.connect(audioCtxAlertaRed.destination);
        osc1.start(now);
        osc1.stop(now + 0.36);

        // Tono 2: Armónico agudo tipo sonar radar cyber (1174.66 Hz - D6 a 1760 Hz - A6)
        const osc2 = audioCtxAlertaRed.createOscillator();
        const gain2 = audioCtxAlertaRed.createGain();
        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(1174.66, now + 0.12);
        osc2.frequency.exponentialRampToValueAtTime(1760, now + 0.26);

        gain2.gain.setValueAtTime(0.001, now + 0.12);
        gain2.gain.linearRampToValueAtTime(0.18, now + 0.16);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

        osc2.connect(gain2);
        gain2.connect(audioCtxAlertaRed.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.56);
    } catch (err) {
        console.warn("AudioContext no disponible o bloqueado por navegador:", err);
    }
}

// Desbloquear AudioContext en la primera interacción si el navegador lo suspendió
window.addEventListener("click", () => {
    if (audioCtxAlertaRed && audioCtxAlertaRed.state === "suspended") {
        audioCtxAlertaRed.resume();
    }
}, { passive: true });

function mostrarNotificacionNuevoDispositivo(dev, totalOnline = "—", totalPending = "—") {
    // Reproducir sonido de alerta cibernética
    reproducirSonidoAlertaRed();

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
// SISTEMA DE AUDIO Y NOTIFICACIONES FLOTANTES EN PANTALLA
// ============================================================
let audioCtxAdmin = null;

function reproducirSonidoAdmin(tipo = "mensaje_recibido") {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!audioCtxAdmin) {
            audioCtxAdmin = new AudioContextClass();
        }
        if (audioCtxAdmin.state === "suspended") {
            audioCtxAdmin.resume();
        }
        const now = audioCtxAdmin.currentTime;

        if (tipo === "mensaje_recibido") {
            // Chime de doble campana armónico (587.33 Hz D5 -> 880 Hz A5)
            const osc1 = audioCtxAdmin.createOscillator();
            const gain1 = audioCtxAdmin.createGain();
            osc1.type = "sine";
            osc1.frequency.setValueAtTime(587.33, now);
            gain1.gain.setValueAtTime(0.001, now);
            gain1.gain.linearRampToValueAtTime(0.24, now + 0.02);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
            osc1.connect(gain1);
            gain1.connect(audioCtxAdmin.destination);
            osc1.start(now);
            osc1.stop(now + 0.24);

            const osc2 = audioCtxAdmin.createOscillator();
            const gain2 = audioCtxAdmin.createGain();
            osc2.type = "sine";
            osc2.frequency.setValueAtTime(880.00, now + 0.10);
            gain2.gain.setValueAtTime(0.001, now + 0.10);
            gain2.gain.linearRampToValueAtTime(0.28, now + 0.12);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.40);
            osc2.connect(gain2);
            gain2.connect(audioCtxAdmin.destination);
            osc2.start(now + 0.10);
            osc2.stop(now + 0.42);
        } else if (tipo === "mensaje_enviado") {
            // Tono suave de envío confirmado (783.99 Hz G5 -> 1046.50 Hz C6)
            const osc = audioCtxAdmin.createOscillator();
            const gain = audioCtxAdmin.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(783.99, now);
            osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.09);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
            osc.connect(gain);
            gain.connect(audioCtxAdmin.destination);
            osc.start(now);
            osc.stop(now + 0.13);
        }
    } catch (_) {}
}

window.addEventListener("click", () => {
    if (audioCtxAdmin && audioCtxAdmin.state === "suspended") {
        audioCtxAdmin.resume();
    }
}, { passive: true });

function mostrarNotificacionMensajeAdmin({ emisor, texto, tag = "Mensaje Nuevo", onClick = null }) {
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
                <span class="nm-emisor">${escapeHtml(emisor || "Estación de Trabajo")}</span>
                <span class="nm-tiempo">Ahora</span>
            </div>
            <div class="nm-texto">${escapeHtml(texto || "Has recibido un nuevo mensaje")}</div>
            <span class="nm-tag">${escapeHtml(tag)}</span>
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

window.mostrarNotificacionMensajeAdmin = mostrarNotificacionMensajeAdmin;
window.reproducirSonidoAdmin = reproducirSonidoAdmin;

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

let cacheArchivos = [];

async function cargarArchivos() {
    const tabla = document.querySelector("#tabla-archivos tbody");
    const mensaje = document.querySelector("#mensaje-archivos");
    if (!tabla) return;

    try {
        const res = await fetch(`${API_URL}/files/`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const archivos = await res.json();
        cacheArchivos = Array.isArray(archivos) ? archivos : [];

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

            const ext = (a.nombre_original || "").split('.').pop().toUpperCase();
            const extLower = (a.nombre_original || "").split('.').pop().toLowerCase();
            const esVisualizable = ["pdf", "jpg", "jpeg", "png", "webp", "gif", "txt", "log", "csv", "json", "py", "md"].includes(extLower);

            const btnVerHtml = esVisualizable ? `
                <button type="button" class="btn btn-ver-archivo" data-id="${a.id}" title="Ver archivo directamente" style="background: rgba(0, 229, 255, 0.12); color: #00E5FF; border: 1px solid rgba(0, 229, 255, 0.35); font-weight: 600; padding: 6px 12px; font-size: 0.8rem; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.2s;">
                    👁️ Ver
                </button>
            ` : '';

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
                        ${btnVerHtml}
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

        // Validación: sólo se permite el mismo nombre base si la extensión es diferente
        const nombreLimpio = (file.name || "").trim().toLowerCase();
        const archivoDuplicado = cacheArchivos.find(a => (a.nombre_original || "").trim().toLowerCase() === nombreLimpio);
        if (archivoDuplicado) {
            mostrarToast(`Ya existe un archivo compartido llamado "${file.name}". Solo puedes usar ese mismo nombre si tiene otra extensión.`, true);
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

// Manejador de acciones en tabla de archivos (Ver y Eliminar)
const elTablaArchivos = document.querySelector("#tabla-archivos");
if (elTablaArchivos) {
    elTablaArchivos.addEventListener("click", async (e) => {
        // 1. Ver archivo
        const btnVer = e.target.closest(".btn-ver-archivo");
        if (btnVer) {
            const id = parseInt(btnVer.dataset.id, 10);
            const archivo = cacheArchivos.find(x => x.id === id);
            if (archivo) {
                abrirVisorArchivoApp(archivo);
            }
            return;
        }

        // 2. Eliminar archivo
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
// VISOR DE ARCHIVOS EN PANEL PRINCIPAL (PDF, IMÁGENES, CÓDIGO)
// ============================================================
const modalVisorApp = document.querySelector("#modal-visor-archivo");
const visorNombreApp = document.querySelector("#visor-nombre");
const visorMetaApp = document.querySelector("#visor-meta");
const visorIconoApp = document.querySelector("#visor-icono");
const visorBodyApp = document.querySelector("#visor-body");
const visorBtnDescargarApp = document.querySelector("#visor-btn-descargar");
const btnCerrarVisorApp = document.querySelector("#btn-cerrar-visor");
const btnCerrarVisorApp2 = document.querySelector("#btn-cerrar-visor-2");

function cerrarVisorApp() {
    if (modalVisorApp) {
        modalVisorApp.classList.remove("active");
        if (visorBodyApp) visorBodyApp.innerHTML = "";
    }
}

if (btnCerrarVisorApp) btnCerrarVisorApp.addEventListener("click", cerrarVisorApp);
if (btnCerrarVisorApp2) btnCerrarVisorApp2.addEventListener("click", cerrarVisorApp);
if (modalVisorApp) {
    modalVisorApp.addEventListener("click", (e) => {
        if (e.target === modalVisorApp) cerrarVisorApp();
    });
}

if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./js/pdf.worker.min.js";
}

async function abrirVisorArchivoApp(archivo) {
    if (!modalVisorApp || !visorBodyApp) return;

    const ext = (archivo.nombre_original || "").split(".").pop().toLowerCase();
    const esImagen = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
    const esPdf = ["pdf"].includes(ext);
    const esTexto = ["txt", "log", "csv", "json", "py", "md"].includes(ext);

    if (visorNombreApp) visorNombreApp.textContent = archivo.nombre_original;
    if (visorMetaApp) visorMetaApp.textContent = `${archivo.descripcion ? archivo.descripcion + " • " : ""}${formatearTamanoBytes(archivo.tamano_bytes)}`;
    if (visorIconoApp) visorIconoApp.textContent = obtenerIconoArchivo(archivo.nombre_original);
    if (visorBtnDescargarApp) visorBtnDescargarApp.href = `${API_URL}/files/${archivo.id}/download`;

    visorBodyApp.innerHTML = '<div class="pulse-indicator" style="text-align: center; padding: 25px;"><span class="pulse-dot"></span> Cargando recurso...</div>';
    modalVisorApp.classList.add("active");

    const viewUrl = `${API_URL}/files/${archivo.id}/view`;

    if (esImagen) {
        const img = document.createElement("img");
        img.className = "visor-img";
        img.src = viewUrl;
        img.alt = archivo.nombre_original;
        img.onload = () => { visorBodyApp.replaceChildren(img); };
        img.onerror = () => {
            visorBodyApp.innerHTML = `<p style="color: #f87171; text-align: center; padding: 20px;">No se pudo previsualizar la imagen.</p>`;
        };
    } else if (esPdf) {
        if (typeof pdfjsLib !== "undefined") {
            visorBodyApp.innerHTML = `
                <div class="pdf-visor-container">
                    <div class="pdf-toolbar">
                        <button type="button" class="pdf-btn" id="app-pdf-btn-prev">◀ Anterior</button>
                        <span>Pág. <strong id="app-pdf-num-pag">1</strong> / <strong id="app-pdf-total-pags">1</strong></span>
                        <button type="button" class="pdf-btn" id="app-pdf-btn-next">Siguiente ▶</button>
                        <span style="opacity: 0.3; margin: 0 4px;">|</span>
                        <button type="button" class="pdf-btn" id="app-pdf-btn-zoom-out" title="Reducir zoom">🔍 -</button>
                        <span id="app-pdf-lbl-zoom" style="font-size: 0.8rem; font-family: monospace; min-width: 42px; text-align: center;">100%</span>
                        <button type="button" class="pdf-btn" id="app-pdf-btn-zoom-in" title="Aumentar zoom">🔍 +</button>
                    </div>
                    <div class="pdf-canvas-wrap" id="app-pdf-canvas-container">
                        <div id="app-pdf-loading-spin" class="pulse-indicator" style="margin: 20px;"><span class="pulse-dot"></span> Cargando documento PDF...</div>
                        <canvas id="app-pdf-render-canvas" class="pdf-canvas" style="display: none;"></canvas>
                    </div>
                </div>
            `;

            let pdfDoc = null;
            let pageNum = 1;
            let pageRendering = false;
            let pageNumPending = null;
            let scale = 1.0;

            const canvas = document.getElementById("app-pdf-render-canvas");
            const ctx = canvas ? canvas.getContext("2d") : null;
            const numPagSpan = document.getElementById("app-pdf-num-pag");
            const totalPagsSpan = document.getElementById("app-pdf-total-pags");
            const lblZoom = document.getElementById("app-pdf-lbl-zoom");
            const btnPrev = document.getElementById("app-pdf-btn-prev");
            const btnNext = document.getElementById("app-pdf-btn-next");
            const btnZoomIn = document.getElementById("app-pdf-btn-zoom-in");
            const btnZoomOut = document.getElementById("app-pdf-btn-zoom-out");
            const loadingSpin = document.getElementById("app-pdf-loading-spin");

            function renderPage(num) {
                if (!pdfDoc || !canvas || !ctx) return;
                pageRendering = true;
                pdfDoc.getPage(num).then(function(page) {
                    const wrapWidth = Math.max(300, (visorBodyApp.clientWidth || window.innerWidth) - 50);
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
                console.error("Error al cargar PDF:", err);
                visorBodyApp.innerHTML = `
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
            visorBodyApp.replaceChildren(iframe);
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
            visorBodyApp.replaceChildren(pre);
        } catch (e) {
            visorBodyApp.innerHTML = `<p style="color: #f87171; text-align: center; padding: 20px;">Error al cargar el contenido de texto.</p>`;
        }
    }
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

            const leidos = m.total_leidos || 0;
            const conectados = m.total_conectados || 1;
            const pct = Math.min(100, Math.round((leidos / conectados) * 100));

            let badgeLecturaClass = "badge-alcance-nivel1";
            if (leidos >= conectados && conectados > 0) {
                badgeLecturaClass = "badge-online";
            } else if (leidos > 0) {
                badgeLecturaClass = "badge-qos";
            } else {
                badgeLecturaClass = "badge-pendientes-pill";
            }

            const colLectura = `
                <div style="display: inline-flex; align-items: center; gap: 8px;">
                    <span class="badge ${badgeLecturaClass}" title="${leidos} de ${conectados} estaciones confirmaron lectura" style="font-weight: 700; font-size: 0.85rem; padding: 4px 10px; display: inline-flex; align-items: center; gap: 5px;">
                        👁️ <span style="font-family: var(--font-mono);">${leidos} / ${conectados}</span>
                    </span>
                    <span style="font-size: 0.76rem; color: var(--text-muted); font-family: var(--font-mono);">${pct}%</span>
                </div>
            `;

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
                    ${colLectura}
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
                reproducirSonidoAdmin("mensaje_enviado");
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

// ── BANDEJA DE ENTRADA Y CHAT DIRECTO PARA EL ADMINISTRADOR ──
let inboxAdminConversaciones = [];
let inboxAdminEstacionActivaIp = null;

function setupInboxAdminSubtabs() {
    const btnSubtabBroadcast = document.querySelector("#btn-subtab-broadcast");
    const btnSubtabInbox = document.querySelector("#btn-subtab-inbox");
    const secBroadcast = document.querySelector("#subseccion-mensajes-broadcast");
    const secInbox = document.querySelector("#subseccion-mensajes-inbox");
    const btnRefrescar = document.querySelector("#btn-refrescar-inbox");

    if (btnSubtabBroadcast && btnSubtabInbox && secBroadcast && secInbox) {
        btnSubtabBroadcast.addEventListener("click", () => {
            btnSubtabBroadcast.classList.add("active");
            btnSubtabInbox.classList.remove("active");
            secBroadcast.style.display = "block";
            secInbox.style.display = "none";
        });

        btnSubtabInbox.addEventListener("click", () => {
            btnSubtabInbox.classList.add("active");
            btnSubtabBroadcast.classList.remove("active");
            secInbox.style.display = "block";
            secBroadcast.style.display = "none";
            cargarBandejaMensajesAdmin();
        });
    }

    if (btnRefrescar) {
        btnRefrescar.addEventListener("click", () => cargarBandejaMensajesAdmin());
    }

    const formResponder = document.querySelector("#form-responder-inbox-admin");
    if (formResponder) {
        formResponder.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (!inboxAdminEstacionActivaIp) return;

            const inputTxt = document.querySelector("#input-respuesta-admin");
            const btnSubmit = document.querySelector("#btn-enviar-respuesta-admin");
            const contenido = inputTxt ? inputTxt.value.trim() : "";
            if (!contenido) return;

            if (btnSubmit) btnSubmit.disabled = true;

            try {
                const res = await fetch(`${API_URL}/groups/admin/reply`, {
                    method: "POST",
                    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                    body: JSON.stringify({ destino_ip: inboxAdminEstacionActivaIp, contenido: contenido })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Error al enviar respuesta");
                }

                if (inputTxt) inputTxt.value = "";
                reproducirSonidoAdmin("mensaje_enviado");
                mostrarToast("✓ Respuesta enviada a la estación");
                await cargarBandejaMensajesAdmin();
            } catch (err) {
                console.error("Error al responder mensaje:", err);
                mostrarToast(err.message || "Error al responder", true);
            } finally {
                if (btnSubmit) btnSubmit.disabled = false;
                if (inputTxt) inputTxt.focus();
            }
        });
    }
}

let inboxAdminKeysConocidas = new Set();
let inboxAdminInicializado = false;

async function cargarBandejaMensajesAdmin(silencioso = false) {
    const elLista = document.querySelector("#lista-conversaciones-inbox");
    const badgeContador = document.querySelector("#badge-inbox-contador");

    try {
        const res = await fetch(`${API_URL}/groups/admin/inbox`, { headers: getAuthHeaders() });
        if (!res.ok) return;

        inboxAdminConversaciones = await res.json();

        // Actualizar contador
        if (badgeContador) {
            const total = inboxAdminConversaciones.length;
            badgeContador.textContent = total;
            badgeContador.style.display = total > 0 ? "inline-block" : "none";
        }

        // Detección de mensajes nuevos para alertar con sonido y notificación en pantalla
        if (!inboxAdminInicializado) {
            inboxAdminConversaciones.forEach(conv => {
                const key = `${conv.ip}_${conv.ultimo_timestamp || conv.ultimo_mensaje || ""}`;
                inboxAdminKeysConocidas.add(key);
            });
            inboxAdminInicializado = true;
        } else {
            inboxAdminConversaciones.forEach(conv => {
                const key = `${conv.ip}_${conv.ultimo_timestamp || conv.ultimo_mensaje || ""}`;
                if (conv.ultimo_mensaje && !inboxAdminKeysConocidas.has(key)) {
                    inboxAdminKeysConocidas.add(key);
                    // Disparar sonido y notificación flotante en pantalla
                    reproducirSonidoAdmin("mensaje_recibido");
                    mostrarNotificacionMensajeAdmin({
                        emisor: `${conv.nombre || "Estación"} (${conv.ip})`,
                        texto: conv.ultimo_mensaje,
                        tag: "Consulta de Estación",
                        onClick: () => {
                            activarPestana("tab-mensajes");
                            const btnInbox = document.querySelector("#btn-subtab-inbox");
                            if (btnInbox) btnInbox.click();
                            inboxAdminEstacionActivaIp = conv.ip;
                            renderizarConversacionActivaAdmin(conv);
                        }
                    });
                }
            });
        }

        if (!elLista) return;

        if (inboxAdminConversaciones.length === 0) {
            elLista.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 30px 14px;">
                    <span style="font-size: 1.8rem; display: block; margin-bottom: 8px;">📭</span>
                    No hay mensajes ni consultas recibidas de las estaciones aún.
                </div>
            `;
            return;
        }

        elLista.innerHTML = "";
        inboxAdminConversaciones.forEach(conv => {
            const esActivo = (conv.ip === inboxAdminEstacionActivaIp);
            const card = document.createElement("div");
            card.className = `inbox-conv-item ${esActivo ? 'active' : ''}`;
            card.style.cssText = `
                padding: 10px 12px;
                border-radius: 8px;
                margin-bottom: 6px;
                cursor: pointer;
                background: ${esActivo ? 'rgba(99, 102, 241, 0.16)' : 'rgba(255, 255, 255, 0.03)'};
                border: 1px solid ${esActivo ? '#6366f1' : 'var(--border-base)'};
                transition: all 0.2s ease;
            `;

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <strong style="font-size: 0.86rem; color: ${esActivo ? '#818cf8' : 'var(--text-primary)'};">${escapeHtml(conv.nombre)}</strong>
                    <span style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${conv.ip}</span>
                </div>
                <div style="font-size: 0.78rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${escapeHtml(conv.ultimo_mensaje || "Archivo adjunto")}
                </div>
            `;

            card.addEventListener("click", () => {
                inboxAdminEstacionActivaIp = conv.ip;
                document.querySelectorAll(".inbox-conv-item").forEach(c => {
                    c.style.background = "rgba(255, 255, 255, 0.03)";
                    c.style.borderColor = "var(--border-base)";
                });
                card.style.background = "rgba(99, 102, 241, 0.16)";
                card.style.borderColor = "#6366f1";
                renderizarConversacionActivaAdmin(conv);
            });

            elLista.appendChild(card);
        });

        // Si hay una estación activa, refrescar su chat
        if (inboxAdminEstacionActivaIp) {
            const convActiva = inboxAdminConversaciones.find(c => c.ip === inboxAdminEstacionActivaIp);
            if (convActiva) {
                renderizarConversacionActivaAdmin(convActiva);
            }
        }
    } catch (err) {
        console.error("Error al cargar inbox admin:", err);
    }
}

function renderizarConversacionActivaAdmin(conv) {
    const elTitulo = document.querySelector("#txt-inbox-estacion-titulo");
    const elIp = document.querySelector("#txt-inbox-estacion-ip");
    const elBadge = document.querySelector("#badge-inbox-estacion-estado");
    const elCaja = document.querySelector("#caja-mensajes-inbox-chat");
    const inputTxt = document.querySelector("#input-respuesta-admin");
    const btnSend = document.querySelector("#btn-enviar-respuesta-admin");

    if (elTitulo) elTitulo.textContent = conv.nombre;
    if (elIp) elIp.textContent = `[${conv.ip}]`;
    if (elBadge) elBadge.style.display = "inline-block";
    if (inputTxt) {
        inputTxt.disabled = false;
        inputTxt.placeholder = `Escribe un mensaje para ${conv.nombre}...`;
    }
    if (btnSend) btnSend.disabled = false;

    if (!elCaja) return;
    elCaja.innerHTML = "";

    conv.mensajes.forEach(m => {
        const esAdmin = (m.emisor === "admin");
        const bubble = document.createElement("div");
        bubble.style.cssText = `
            max-width: 78%;
            align-self: ${esAdmin ? 'flex-end' : 'flex-start'};
            background: ${esAdmin ? 'linear-gradient(135deg, #4f46e5, #7c3aed)' : 'var(--bg-card)'};
            color: #FFFFFF;
            border: 1px solid ${esAdmin ? 'transparent' : 'var(--border-base)'};
            border-radius: ${esAdmin ? '14px 14px 2px 14px' : '14px 14px 14px 2px'};
            padding: 10px 14px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        `;

        const hora = new Date(m.creado_en).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

        let adjuntoHtml = "";
        if (m.tiene_archivo && m.archivo_nombre) {
            adjuntoHtml = `
                <div style="margin-top: 8px; padding: 6px 10px; background: rgba(0,0,0,0.2); border-radius: 6px; display: flex; align-items: center; gap: 8px;">
                    <span>📎</span>
                    <strong style="font-size: 0.8rem;">${escapeHtml(m.archivo_nombre)}</strong>
                    <a href="${API_URL}/groups/chat/download/${m.id}" download="${escapeHtml(m.archivo_nombre)}" target="_blank" style="margin-left: auto; color: #a5b4fc; font-size: 0.75rem; text-decoration: underline;">
                        ⬇️ Descargar
                    </a>
                </div>
            `;
        }

        bubble.innerHTML = `
            <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; font-size: 0.74rem; opacity: 0.85;">
                <strong>${escapeHtml(m.emisor_nombre)}</strong>
                <span>${hora}</span>
            </div>
            <div style="font-size: 0.88rem; line-height: 1.4;">${escapeHtml(m.contenido)}</div>
            ${adjuntoHtml}
        `;

        elCaja.appendChild(bubble);
    });

    // Auto-scroll al final
    elCaja.scrollTop = elCaja.scrollHeight;
}

setupInboxAdminSubtabs();

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

let sincronizacionSilenciosaEnCurso = false;

async function sincronizarDispositivosSilencioso() {
    if (sincronizacionSilenciosaEnCurso) return;
    sincronizacionSilenciosaEnCurso = true;
    try {
        await fetch(`${API_URL}/devices/sync`, { method: "POST", headers: getAuthHeaders() });
        await cargarDispositivos();
    } catch (e) {
        // silencioso
    } finally {
        sincronizacionSilenciosaEnCurso = false;
    }
}

// ============================================================
// GESTIÓN DE TEMA: MODO CLARO Y MODO OSCURO
// ============================================================
function inicializarTema() {
    const temaGuardado = localStorage.getItem("networklab_theme") || "dark";
    aplicarTema(temaGuardado);

    const btnToggle = document.querySelector("#btn-toggle-theme");
    if (btnToggle) {
        btnToggle.addEventListener("click", () => {
            const actual = document.documentElement.getAttribute("data-theme") || "dark";
            const nuevo = actual === "light" ? "dark" : "light";
            aplicarTema(nuevo);
        });
    }
}

function aplicarTema(tema) {
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

    actualizarTemaGraficos(tema);
}

function actualizarTemaGraficos(tema) {
    const colorTexto = tema === "light" ? "#334155" : "#94A3B8";
    const colorGrid = tema === "light" ? "rgba(203, 213, 225, 0.6)" : "rgba(255, 255, 255, 0.05)";
    const borderDona = tema === "light" ? "#FFFFFF" : "#121826";

    if (chartConsumoInstance && chartConsumoInstance.options) {
        if (chartConsumoInstance.options.scales) {
            if (chartConsumoInstance.options.scales.x && chartConsumoInstance.options.scales.x.ticks) {
                chartConsumoInstance.options.scales.x.ticks.color = colorTexto;
            }
            if (chartConsumoInstance.options.scales.y) {
                if (chartConsumoInstance.options.scales.y.ticks) chartConsumoInstance.options.scales.y.ticks.color = colorTexto;
                if (chartConsumoInstance.options.scales.y.grid) chartConsumoInstance.options.scales.y.grid.color = colorGrid;
            }
        }
        if (chartConsumoInstance.options.plugins && chartConsumoInstance.options.plugins.legend) {
            chartConsumoInstance.options.plugins.legend.labels.color = colorTexto;
        }
        chartConsumoInstance.update();
    }

    if (chartCategoriasInstance && chartCategoriasInstance.options) {
        if (chartCategoriasInstance.data && chartCategoriasInstance.data.datasets && chartCategoriasInstance.data.datasets[0]) {
            chartCategoriasInstance.data.datasets[0].borderColor = borderDona;
        }
        if (chartCategoriasInstance.options.plugins && chartCategoriasInstance.options.plugins.legend) {
            chartCategoriasInstance.options.plugins.legend.labels.color = colorTexto;
        }
        chartCategoriasInstance.update();
    }

    if (chartActividadDonaInstance && chartActividadDonaInstance.options) {
        if (chartActividadDonaInstance.data && chartActividadDonaInstance.data.datasets && chartActividadDonaInstance.data.datasets[0]) {
            chartActividadDonaInstance.data.datasets[0].borderColor = borderDona;
        }
        if (chartActividadDonaInstance.options.plugins && chartActividadDonaInstance.options.plugins.legend) {
            chartActividadDonaInstance.options.plugins.legend.labels.color = colorTexto;
        }
        chartActividadDonaInstance.update();
    }
}

// =========================================================================
// --- MÓDULO: HISTORIAL DE ACTIVIDAD Y MONITOREO DE APLICACIONES ---
// =========================================================================

let cacheActividadDispositivos = [];
let chartActividadDonaInstance = null;
let modalActividadDeviceIdActual = null;
let modalActividadPeriodoActual = "hoy";
let modalActividadVistaActual = "apps";
let modalActividadDataCache = null;

const ICONS_DISPOSITIVOS_SVG = {
    desktop: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    notebook: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>`,
    smartphone: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    tablet: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="3"/><circle cx="12" cy="18" r="1"/></svg>`
};

const NOMBRES_TIPO_DISPOSITIVO = {
    desktop: "Computadora PC / Escritorio",
    notebook: "Notebook / Laptop",
    smartphone: "Teléfono Móvil / Celular",
    tablet: "Tablet"
};

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function cargarActividadDispositivos(silencioso = false) {
    const elGrid = document.querySelector("#grid-dispositivos-actividad");
    if (!silencioso && elGrid) {
        elGrid.innerHTML = `
            <div class="activity-loading-placeholder">
                <div class="spinner"></div>
                <p>Inspeccionando conexiones de red en tiempo real...</p>
            </div>
        `;
    }

    try {
        const res = await fetch(`${API_URL}/activity/devices`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error("Error al obtener actividad de dispositivos");

        const data = await res.json();
        cacheActividadDispositivos = Array.isArray(data) ? data : [];

        // Actualizar KPIs de Actividad
        const kpiTotal = document.querySelector("#kpi-act-total-disp");
        const kpiJuegos = document.querySelector("#kpi-act-en-juegos");
        const kpiVideo = document.querySelector("#kpi-act-en-video");
        const kpiEstudio = document.querySelector("#kpi-act-en-estudio");

        if (kpiTotal) kpiTotal.textContent = cacheActividadDispositivos.length;
        if (kpiJuegos) kpiJuegos.textContent = cacheActividadDispositivos.filter(d => d.categoria_actual === "juegos").length;
        if (kpiVideo) kpiVideo.textContent = cacheActividadDispositivos.filter(d => d.categoria_actual === "streaming").length;
        if (kpiEstudio) kpiEstudio.textContent = cacheActividadDispositivos.filter(d => ["estudio", "general"].includes(d.categoria_actual)).length;

        renderizarGridActividadDispositivos();
    } catch (err) {
        console.error("Error al cargar actividad de dispositivos:", err);
        if (elGrid && !silencioso) {
            elGrid.innerHTML = `
                <div class="activity-loading-placeholder" style="color: #ef4444;">
                    <p>⚠️ No se pudo obtener la información de actividad en este momento.</p>
                </div>
            `;
        }
    }
}

function renderizarGridActividadDispositivos() {
    const elGrid = document.querySelector("#grid-dispositivos-actividad");
    if (!elGrid) return;

    const inputBuscar = document.querySelector("#input-buscar-actividad");
    const query = (inputBuscar ? inputBuscar.value : "").trim().toLowerCase();

    const dispositivosFiltrados = cacheActividadDispositivos.filter(d => {
        if (!query) return true;
        return (d.nombre_host || "").toLowerCase().includes(query) ||
               (d.direccion_ip || "").toLowerCase().includes(query) ||
               (d.direccion_mac || "").toLowerCase().includes(query) ||
               (d.actividad_actual || "").toLowerCase().includes(query);
    });

    if (dispositivosFiltrados.length === 0) {
        elGrid.innerHTML = `
            <div class="activity-loading-placeholder">
                <p>No se encontraron equipos aprobados con los criterios de búsqueda.</p>
            </div>
        `;
        return;
    }

    elGrid.innerHTML = dispositivosFiltrados.map(dev => {
        const tipo = dev.tipo_dispositivo || "desktop";
        const svgIcon = ICONS_DISPOSITIVOS_SVG[tipo] || ICONS_DISPOSITIVOS_SVG.desktop;
        const cat = dev.categoria_actual || "general";

        let iconWrapClass = "device-act-icon-wrap";
        if (cat === "juegos") iconWrapClass += " gaming";
        else if (cat === "streaming") iconWrapClass += " streaming";
        else if (cat === "estudio") iconWrapClass += " study";

        let liveBadgeHtml = "";
        if (cat === "juegos") {
            liveBadgeHtml = `<span class="device-act-live-badge badge-gaming">🎮 En Partida: ${escapeHtml(dev.actividad_actual || "Dota 2 / Steam")}</span>`;
        } else if (cat === "streaming") {
            liveBadgeHtml = `<span class="device-act-live-badge badge-streaming">🎬 En Vivo: ${escapeHtml(dev.actividad_actual || "Streaming")}</span>`;
        } else if (cat === "estudio") {
            liveBadgeHtml = `<span class="device-act-live-badge badge-study">📚 Activo: ${escapeHtml(dev.actividad_actual || "Plataforma Estudio")}</span>`;
        } else if (dev.en_linea) {
            liveBadgeHtml = `<span class="device-act-live-badge badge-idle">⚡ En Línea: ${escapeHtml(dev.actividad_actual || "Navegación")}</span>`;
        } else {
            liveBadgeHtml = `<span class="device-act-live-badge badge-idle" style="opacity: 0.65;">💤 Inactivo / Desconectado</span>`;
        }

        const onlineBadge = dev.en_linea 
            ? `<span class="badge badge-online">🟢 Online</span>` 
            : `<span class="badge badge-rejected" style="opacity: 0.7;">⚪ Offline</span>`;

        const rolBadge = `<span class="user-role-badge role-${(dev.rol || 'nivel_1').replace('_', '')}">${escapeHtml((dev.rol || 'Nivel 1').toUpperCase())}</span>`;

        const horasMin = dev.minutos_hoy >= 60 
            ? `${Math.floor(dev.minutos_hoy / 60)}h ${dev.minutos_hoy % 60}m` 
            : `${dev.minutos_hoy} min`;

        return `
            <div class="device-activity-card" data-device-id="${dev.id}">
                <div>
                    <div class="device-act-header">
                        <div class="${iconWrapClass}">
                            ${svgIcon}
                        </div>
                        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                            ${rolBadge}
                            ${onlineBadge}
                        </div>
                    </div>
                    <div class="device-act-body">
                        <h4 title="${escapeHtml(dev.nombre_host)}">${escapeHtml(dev.nombre_host)}</h4>
                        <div class="device-act-tags">
                            <span class="td-mono">${escapeHtml(dev.direccion_ip)}</span>
                            <span>•</span>
                            <span class="td-mono" style="font-size: 0.75rem;">${escapeHtml(dev.direccion_mac)}</span>
                        </div>
                        ${liveBadgeHtml}
                    </div>
                </div>
                <div class="device-act-footer">
                    <div class="device-act-footer-stat">
                        <span class="device-act-footer-val">${horasMin}</span>
                        <span class="device-act-footer-lbl">⏱️ Tiempo Hoy</span>
                    </div>
                    <div class="device-act-footer-stat" style="text-align: right;">
                        <span class="device-act-footer-val">${dev.trafico_mb_hoy} MB</span>
                        <span class="device-act-footer-lbl">📊 Tráfico Hoy</span>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    // Agregar evento click a cada tarjeta para abrir el modal de detalle
    elGrid.querySelectorAll(".device-activity-card").forEach(card => {
        card.addEventListener("click", () => {
            const devId = card.dataset.deviceId;
            if (devId) {
                abrirModalDetalleActividad(devId, modalActividadPeriodoActual || "hoy");
            }
        });
    });
}

async function abrirModalDetalleActividad(deviceId, periodo = "hoy") {
    modalActividadDeviceIdActual = deviceId;
    modalActividadPeriodoActual = periodo;

    const modal = document.querySelector("#modal-detalle-actividad");
    if (!modal) return;
    modal.style.display = "flex";

    // Resaltar píldora de período activa
    document.querySelectorAll(".btn-period-pill").forEach(btn => {
        if (btn.dataset.periodo === periodo) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    const elCategoriasLista = document.querySelector("#modal-act-categorias-lista");
    if (elCategoriasLista) {
        elCategoriasLista.innerHTML = `
            <div style="text-align: center; padding: 25px; color: var(--color-texto-suave);">
                <div class="spinner" style="margin: 0 auto 10px;"></div>
                <p>Cargando radiografía de aplicaciones para el período seleccionado...</p>
            </div>
        `;
    }

    try {
        const res = await fetch(`${API_URL}/activity/device/${deviceId}?periodo=${periodo}`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error("Error al obtener detalle de actividad");

        const data = await res.json();
        const dev = data.dispositivo;

        // Cabecera del Modal
        const elIcono = document.querySelector("#modal-act-icono");
        const elNombre = document.querySelector("#modal-act-nombre");
        const elBadgeEstado = document.querySelector("#modal-act-badge-estado");
        const elBadgeRol = document.querySelector("#modal-act-badge-rol");
        const elIp = document.querySelector("#modal-act-ip");
        const elMac = document.querySelector("#modal-act-mac");
        const elTipo = document.querySelector("#modal-act-tipo-texto");

        if (elIcono) elIcono.innerHTML = ICONS_DISPOSITIVOS_SVG[dev.tipo_dispositivo] || ICONS_DISPOSITIVOS_SVG.desktop;
        if (elNombre) elNombre.textContent = dev.nombre_host;
        if (elBadgeEstado) {
            elBadgeEstado.className = dev.en_linea ? "badge badge-online" : "badge badge-rejected";
            elBadgeEstado.textContent = dev.en_linea ? "🟢 En Línea" : "⚪ Desconectado";
        }
        if (elBadgeRol) {
            elBadgeRol.className = `user-role-badge role-${(dev.rol || 'nivel_1').replace('_', '')}`;
            elBadgeRol.textContent = (dev.rol || "Nivel 1").toUpperCase();
        }
        if (elIp) elIp.textContent = dev.direccion_ip;
        if (elMac) elMac.textContent = dev.direccion_mac;
        if (elTipo) elTipo.textContent = NOMBRES_TIPO_DISPOSITIVO[dev.tipo_dispositivo] || "Computadora PC";

        // Métricas Resumen
        const elTiempoTotal = document.querySelector("#modal-act-tiempo-total");
        const elTiempoSub = document.querySelector("#modal-act-tiempo-sub");
        const elDescargaTotal = document.querySelector("#modal-act-descarga-total");
        const elSubidaTotal = document.querySelector("#modal-act-subida-total");
        const elEstadoVivo = document.querySelector("#modal-act-estado-vivo");

        const horasTotal = Math.floor(data.tiempo_total_minutos / 60);
        const minsRestantes = data.tiempo_total_minutos % 60;
        if (elTiempoTotal) elTiempoTotal.textContent = `${horasTotal}h ${minsRestantes}m`;
        if (elTiempoSub) {
            elTiempoSub.textContent = periodo === "hoy" ? "Total hoy" : (periodo === "semana" ? "Últimos 7 días" : "Histórico acumulado");
        }
        if (elDescargaTotal) elDescargaTotal.textContent = `${data.total_descarga_mb} MB`;
        if (elSubidaTotal) elSubidaTotal.textContent = `${data.total_subida_mb} MB`;
        if (elEstadoVivo) {
            elEstadoVivo.textContent = data.actividad_actual;
            if (data.actividad_actual.includes("Dota") || data.actividad_actual.includes("Steam")) {
                elEstadoVivo.style.color = "#ec4899";
            } else if (data.actividad_actual.includes("Streaming") || data.actividad_actual.includes("YouTube")) {
                elEstadoVivo.style.color = "#ef4444";
            } else if (data.actividad_actual.includes("Educativ") || data.actividad_actual.includes("Classroom")) {
                elEstadoVivo.style.color = "#10b981";
            } else {
                elEstadoVivo.style.color = "var(--color-primario)";
            }
        }

        modalActividadDataCache = data;

        const elCountApps = document.querySelector("#modal-act-count-apps");
        if (elCountApps) {
            elCountApps.textContent = data.total_aplicaciones || (data.aplicaciones ? data.aplicaciones.length : 0);
        }

        // Sincronizar estilo de pestañas (Apps vs Categorías)
        const tabApps = document.querySelector("#tab-act-apps");
        const tabCats = document.querySelector("#tab-act-cats");
        if (tabApps && tabCats) {
            if (modalActividadVistaActual === "apps") {
                tabApps.classList.add("active");
                tabCats.classList.remove("active");
            } else {
                tabCats.classList.add("active");
                tabApps.classList.remove("active");
            }
        }

        // Renderizar la vista seleccionada (por defecto lista dinámica de Aplicaciones y Sitios Web)
        renderizarDesgloseModalActividad(modalActividadVistaActual);

        // Gráfico Dona de Distribución (Chart.js)
        const ctxDona = document.getElementById("chart-actividad-dona");
        if (ctxDona) {
            if (chartActividadDonaInstance) {
                chartActividadDonaInstance.destroy();
            }
            const esLight = document.documentElement.getAttribute("data-theme") === "light";
            const colorTextoDona = esLight ? "#334155" : "#CBD5E1";
            const borderDona = esLight ? "#FFFFFF" : "#121826";

            chartActividadDonaInstance = new Chart(ctxDona, {
                type: "doughnut",
                data: {
                    labels: data.grafico.labels,
                    datasets: [{
                        data: data.grafico.data,
                        backgroundColor: data.grafico.colors,
                        hoverBackgroundColor: data.grafico.colors,
                        borderColor: borderDona,
                        borderWidth: 2,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: "68%",
                    plugins: {
                        legend: {
                            position: "bottom",
                            labels: {
                                color: colorTextoDona,
                                font: { size: 11, family: "'Plus Jakarta Sans', sans-serif" },
                                boxWidth: 12,
                                padding: 10
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const val = context.raw || 0;
                                    return ` ${context.label}: ${val} minutos`;
                                }
                            }
                        }
                    }
                }
            });
        }
    } catch (err) {
        console.error("Error al abrir detalle de actividad:", err);
        if (elCategoriasLista) {
            elCategoriasLista.innerHTML = `
                <div style="text-align: center; padding: 25px; color: #ef4444;">
                    <p>⚠️ No se pudo cargar el desglose de actividad para este equipo.</p>
                </div>
            `;
        }
    }
}

function renderizarDesgloseModalActividad(vista = "apps") {
    modalActividadVistaActual = vista;
    const elCategoriasLista = document.querySelector("#modal-act-categorias-lista");
    if (!elCategoriasLista || !modalActividadDataCache) return;

    const data = modalActividadDataCache;

    if (vista === "apps") {
        const apps = data.aplicaciones || [];
        if (apps.length === 0) {
            elCategoriasLista.innerHTML = `
                <div style="text-align: center; padding: 35px 20px; color: var(--color-texto-suave);">
                    <div style="font-size: 2.2rem; margin-bottom: 8px;">🌐</div>
                    <p style="font-weight: 600; color: var(--color-texto); font-size: 0.95rem;">Sin aplicaciones registradas en este período</p>
                    <p style="font-size: 0.8rem; opacity: 0.75; margin-top: 4px;">A medida que el dispositivo navegue o use servicios online, aparecerán aquí con su consumo exacto.</p>
                </div>
            `;
            return;
        }

        elCategoriasLista.innerHTML = apps.map(app => {
            const horas = Math.floor(app.minutos / 60);
            const mins = app.minutos % 60;
            const tiempoTxt = horas > 0 ? `${horas}h ${mins}m` : `${app.minutos} min`;
            const liveBadge = app.esta_activa 
                ? `<span class="activity-live-badge"><span class="activity-live-dot"></span>En tiempo real</span>` 
                : "";
            const domainHtml = (app.dominio && app.dominio !== "web") 
                ? `<span class="activity-app-domain">🔗 ${escapeHtml(app.dominio)}</span>` 
                : "";

            return `
                <div class="activity-app-card ${app.esta_activa ? 'active-pulse-border' : ''}">
                    <div class="activity-app-header">
                        <div class="activity-app-ident">
                            <div class="activity-app-icon-bubble" style="background: ${app.color}22; color: ${app.color}; border: 1px solid ${app.color}55;">
                                <span>${app.icono || '🌐'}</span>
                            </div>
                            <div>
                                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                    <span class="activity-app-name">${escapeHtml(app.nombre)}</span>
                                    ${liveBadge}
                                </div>
                                <div class="activity-app-meta">
                                    <span class="activity-app-cat-tag" style="background: ${app.color}18; color: ${app.color}; border: 1px solid ${app.color}33;">
                                        ${escapeHtml(app.categoria_nombre)}
                                    </span>
                                    ${domainHtml}
                                </div>
                            </div>
                        </div>
                        <div class="activity-app-time-block">
                            <div class="activity-app-time" style="color: ${app.color};">
                                ${tiempoTxt}
                            </div>
                            <div class="activity-app-pct">${app.porcentaje}% del uso</div>
                        </div>
                    </div>

                    <div class="activity-cat-bar-bg" style="margin-top: 10px;">
                        <div class="activity-cat-bar-fill" style="width: ${Math.min(100, Math.max(3, app.porcentaje))}%; background-color: ${app.color};"></div>
                    </div>

                    <div class="activity-app-footer">
                        <span style="font-size: 0.72rem; color: var(--color-texto-suave);">Tráfico de red:</span>
                        <span class="activity-app-traffic-numbers">
                            ⬇️ <strong style="color: var(--color-texto);">${app.descarga_mb} MB</strong> &nbsp;|&nbsp; ⬆️ <strong style="color: var(--color-texto);">${app.subida_mb} MB</strong>
                        </span>
                    </div>
                </div>
            `;
        }).join("");
    } else {
        // Vista de Categorías Agrupadas (solo categorías con actividad)
        const cats = data.categorias || [];
        if (cats.length === 0) {
            elCategoriasLista.innerHTML = `
                <div style="text-align: center; padding: 35px 20px; color: var(--color-texto-suave);">
                    <p style="font-weight: 600; color: var(--color-texto);">Sin categorías activas en este período</p>
                </div>
            `;
            return;
        }

        elCategoriasLista.innerHTML = cats.map(cat => {
            const appsHtml = (cat.apps_detectadas && cat.apps_detectadas.length > 0)
                ? cat.apps_detectadas.map(a => `<span class="activity-cat-app-tag">${escapeHtml(a)}</span>`).join("")
                : `<span class="activity-cat-app-tag" style="opacity: 0.6;">Sin aplicaciones</span>`;

            return `
                <div class="activity-cat-card">
                    <div class="activity-cat-header">
                        <div class="activity-cat-title">
                            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${cat.color};"></span>
                            <span>${cat.icono || ''} ${escapeHtml(cat.nombre)}</span>
                        </div>
                        <div class="activity-cat-metrics" style="color: ${cat.color};">
                            <span>${cat.minutos} min</span>
                            <span style="opacity: 0.6; font-size: 0.75rem;">(${cat.porcentaje}%)</span>
                        </div>
                    </div>
                    <div class="activity-cat-bar-bg">
                        <div class="activity-cat-bar-fill" style="width: ${Math.min(100, cat.porcentaje)}%; background-color: ${cat.color};"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 0.74rem; color: var(--color-texto-suave); flex-wrap: wrap; gap: 6px;">
                        <div class="activity-cat-apps">${appsHtml}</div>
                        <div style="font-family: var(--font-mono); font-size: 0.72rem; white-space: nowrap;">
                            ⬇️ ${cat.descarga_mb} MB | ⬆️ ${cat.subida_mb} MB
                        </div>
                    </div>
                </div>
            `;
        }).join("");
    }
}

function cerrarModalActividad() {
    const modal = document.querySelector("#modal-detalle-actividad");
    if (modal) modal.style.display = "none";
}

// Listeners del Módulo de Actividad
const btnCerrarAct = document.querySelector("#btn-cerrar-modal-actividad");
const btnCerrarActFooter = document.querySelector("#btn-cerrar-modal-act-footer");
const modalActividadBackdrop = document.querySelector("#modal-detalle-actividad");
const inputBuscarAct = document.querySelector("#input-buscar-actividad");
const btnRefreshAct = document.querySelector("#btn-refresh-actividad");

if (btnCerrarAct) btnCerrarAct.addEventListener("click", cerrarModalActividad);
if (btnCerrarActFooter) btnCerrarActFooter.addEventListener("click", cerrarModalActividad);
if (modalActividadBackdrop) {
    modalActividadBackdrop.addEventListener("click", (e) => {
        if (e.target === modalActividadBackdrop) cerrarModalActividad();
    });
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        cerrarModalActividad();
    }
});

// Pestañas de Vista: Aplicaciones vs Categorías
const tabAppsBtn = document.querySelector("#tab-act-apps");
const tabCatsBtn = document.querySelector("#tab-act-cats");

if (tabAppsBtn) {
    tabAppsBtn.addEventListener("click", () => {
        modalActividadVistaActual = "apps";
        tabAppsBtn.classList.add("active");
        if (tabCatsBtn) tabCatsBtn.classList.remove("active");
        renderizarDesgloseModalActividad("apps");
    });
}

if (tabCatsBtn) {
    tabCatsBtn.addEventListener("click", () => {
        modalActividadVistaActual = "categorias";
        tabCatsBtn.classList.add("active");
        if (tabAppsBtn) tabAppsBtn.classList.remove("active");
        renderizarDesgloseModalActividad("categorias");
    });
}

// Botones de Selección de Período (Hoy, Semana, Histórico)
document.querySelectorAll(".btn-period-pill").forEach(btn => {
    btn.addEventListener("click", () => {
        const nuevoPeriodo = btn.dataset.periodo;
        if (modalActividadDeviceIdActual) {
            abrirModalDetalleActividad(modalActividadDeviceIdActual, nuevoPeriodo);
        }
    });
});

if (inputBuscarAct) {
    inputBuscarAct.addEventListener("input", () => {
        renderizarGridActividadDispositivos();
    });
}

if (btnRefreshAct) {
    btnRefreshAct.addEventListener("click", () => {
        cargarActividadDispositivos(false);
    });
}

// Carga inicial y actualización periódica automática
inicializarTema();
verificarEstadoMikrotik();
sincronizarDispositivosSilencioso();
cargarSesionesActivas();
cargarDominiosBloqueados();
cargarUsuarios();
cargarPoliticasRoles();
cargarArchivos();
cargarMensajes();
cargarActividadDispositivos(true);

// =========================================================================
// --- MÓDULO: MESAS DE TRABAJO, AISLAMIENTO Y LIENZO INTERACTIVO DE RED ---
// =========================================================================

let cacheGrupos = [];
let cacheDispositivosCanvas = [];
let dispositivosSeleccionadosCanvas = new Set();
let nodoActivoCanvasIndex = 0;
let modoAislamientoActivo = false;
let nodosPosicionesCanvas = [];

async function cargarModuloGrupos(silencioso = false) {
    try {
        // 1. Obtener estado del aislamiento global
        const resStatus = await fetch(`${API_URL}/groups/status`, { headers: getAuthHeaders() });
        if (resStatus.ok) {
            const dataStatus = await resStatus.json();
            modoAislamientoActivo = !!dataStatus.aislamiento_activo;
            actualizarUiSwitchAislamiento(modoAislamientoActivo);
        }

        // 2. Obtener dispositivos para el lienzo
        const resCanvas = await fetch(`${API_URL}/groups/canvas-devices`, { headers: getAuthHeaders() });
        if (resCanvas.ok) {
            cacheDispositivosCanvas = await resCanvas.json();
            renderizarLienzoRedGrupos();
        }

        // 3. Obtener lista de grupos
        const resGrupos = await fetch(`${API_URL}/groups`, { headers: getAuthHeaders() });
        if (resGrupos.ok) {
            cacheGrupos = await resGrupos.json();
            renderizarTarjetasGrupos();
        }
    } catch (err) {
        console.error("Error al cargar módulo de grupos:", err);
    }
}

function actualizarUiSwitchAislamiento(activo) {
    const btnSwitch = document.querySelector("#btn-toggle-modo-aislamiento");
    const txtModo = document.querySelector("#txt-modo-aislamiento");
    if (!btnSwitch || !txtModo) return;

    if (activo) {
        btnSwitch.className = "btn-isolation-switch activo";
        txtModo.textContent = "ACTIVADO (Grupos Aislados)";
    } else {
        btnSwitch.className = "btn-isolation-switch inactivo";
        txtModo.textContent = "DESACTIVADO (Red Abierta)";
    }
}

async function alternarModoAislamientoGlobal() {
    const nuevoEstado = !modoAislamientoActivo;
    try {
        const res = await fetch(`${API_URL}/groups/toggle-isolation`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ activo: nuevoEstado })
        });
        if (!res.ok) throw new Error("Error al cambiar modo aislamiento");

        const data = await res.json();
        modoAislamientoActivo = data.aislamiento_activo;
        actualizarUiSwitchAislamiento(modoAislamientoActivo);
    } catch (err) {
        console.error("Error al alternar aislamiento:", err);
        alert("No se pudo cambiar el modo de aislamiento en este momento.");
    }
}

// --- LIENZO INTERACTIVO DE RED (Canvas / Nodos / Láser) ---

// Registro de posiciones persistentes para que los dispositivos no cambien de lugar
const posicionesPersistentesNodos = new Map();
let nodoEnArrastre = null;
let arrastreHuboMovimiento = false;

function renderizarLienzoRedGrupos() {
    const canvas = document.querySelector("#canvas-grafo-grupos");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 1000;
    const height = rect.height || 420;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const esModoClaro = document.documentElement.getAttribute("data-theme") === "light";

    // Dibujar cuadrícula de fondo sutil y técnica
    ctx.save();
    const gridSize = 28;
    ctx.strokeStyle = esModoClaro ? "rgba(203, 213, 225, 0.45)" : "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    ctx.restore();

    // Ordenar dispositivos por id para garantizar orden 100% determinista
    const rawDevices = (cacheDispositivosCanvas || []).slice();
    rawDevices.sort((a, b) => a.id - b.id);

    if (rawDevices.length === 0) {
        ctx.fillStyle = esModoClaro ? "#475569" : "#94a3b8";
        ctx.font = "600 14px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No hay dispositivos aprobados en la red para mostrar en el mapa.", width / 2, height / 2);
        nodosPosicionesCanvas = [];
        return;
    }

    // Calcular posiciones de nodos estables y fijas
    const centerX = width / 2;
    const centerY = height / 2;
    const radiusX = Math.min(centerX - 90, 380);
    const radiusY = Math.min(centerY - 70, 140);

    nodosPosicionesCanvas = rawDevices.map((dev, idx) => {
        let posX, posY;
        if (posicionesPersistentesNodos.has(dev.id)) {
            const p = posicionesPersistentesNodos.get(dev.id);
            posX = p.x;
            posY = p.y;
        } else {
            const angle = (idx / rawDevices.length) * 2 * Math.PI - Math.PI / 2;
            posX = centerX + radiusX * Math.cos(angle);
            posY = centerY + radiusY * Math.sin(angle);
            posicionesPersistentesNodos.set(dev.id, { x: posX, y: posY });
        }

        return {
            device: dev,
            x: posX,
            y: posY,
            radius: 28,
            index: idx
        };
    });

    // 1. Dibujar líneas de grupos ya conformados
    const gruposMap = {};
    nodosPosicionesCanvas.forEach(n => {
        if (n.device.grupo_id) {
            if (!gruposMap[n.device.grupo_id]) {
                gruposMap[n.device.grupo_id] = {
                    nombre: n.device.grupo_nombre || "Grupo",
                    color: n.device.grupo_color || "#6366f1",
                    nodes: []
                };
            }
            gruposMap[n.device.grupo_id].nodes.push(n);
        }
    });

    Object.values(gruposMap).forEach(g => {
        if (g.nodes.length >= 2) {
            ctx.save();
            ctx.strokeStyle = g.color;
            ctx.lineWidth = esModoClaro ? 3.5 : 2.5;
            ctx.shadowColor = g.color;
            ctx.shadowBlur = esModoClaro ? 4 : 12;
            ctx.globalAlpha = esModoClaro ? 0.85 : 0.65;

            ctx.beginPath();
            if (g.nodes.length === 2) {
                ctx.moveTo(g.nodes[0].x, g.nodes[0].y);
                ctx.lineTo(g.nodes[1].x, g.nodes[1].y);
                ctx.stroke();
            } else {
                ctx.moveTo(g.nodes[0].x, g.nodes[0].y);
                for (let i = 1; i < g.nodes.length; i++) {
                    ctx.lineTo(g.nodes[i].x, g.nodes[i].y);
                }
                ctx.closePath();
                ctx.fillStyle = g.color;
                ctx.globalAlpha = esModoClaro ? 0.12 : 0.08;
                ctx.fill();
                ctx.globalAlpha = esModoClaro ? 0.85 : 0.55;
                ctx.stroke();
            }
            ctx.restore();
        }
    });

    // 2. Dibujar líneas luminosas de selección interactiva actual
    const nodosSeleccionados = nodosPosicionesCanvas.filter(n => dispositivosSeleccionadosCanvas.has(n.device.id));
    if (nodosSeleccionados.length >= 2) {
        ctx.save();
        ctx.strokeStyle = esModoClaro ? "#0284c7" : "#00E5FF";
        ctx.lineWidth = 3.5;
        ctx.shadowColor = esModoClaro ? "#0284c7" : "#00E5FF";
        ctx.shadowBlur = 14;
        ctx.setLineDash([8, 6]);

        ctx.beginPath();
        ctx.moveTo(nodosSeleccionados[0].x, nodosSeleccionados[0].y);
        for (let i = 1; i < nodosSeleccionados.length; i++) {
            ctx.lineTo(nodosSeleccionados[i].x, nodosSeleccionados[i].y);
        }
        if (nodosSeleccionados.length >= 3) {
            ctx.closePath();
            ctx.fillStyle = esModoClaro ? "rgba(2, 132, 199, 0.12)" : "rgba(0, 229, 255, 0.12)";
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
    }

    // 3. Dibujar cada nodo (estación de trabajo)
    nodosPosicionesCanvas.forEach((n, idx) => {
        const esSeleccionado = dispositivosSeleccionadosCanvas.has(n.device.id);
        const esFocoTeclado = (idx === nodoActivoCanvasIndex);
        const enLinea = n.device.en_linea;
        const colorGrupo = n.device.grupo_color;

        ctx.save();

        // Halo si está seleccionado o con foco de teclado
        if (esSeleccionado || esFocoTeclado) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.radius + 7, 0, Math.PI * 2);
            ctx.strokeStyle = esSeleccionado ? (esModoClaro ? "#0284c7" : "#00E5FF") : (esModoClaro ? "#94a3b8" : "rgba(255, 255, 255, 0.4)");
            ctx.lineWidth = esSeleccionado ? 3 : 1.5;
            if (esFocoTeclado) ctx.setLineDash([4, 4]);
            ctx.shadowColor = esSeleccionado ? (esModoClaro ? "#0284c7" : "#00E5FF") : "transparent";
            ctx.shadowBlur = esSeleccionado ? 14 : 0;
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Anillo de grupo si pertenece a uno
        if (colorGrupo) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.radius + 3.5, 0, Math.PI * 2);
            ctx.strokeStyle = colorGrupo;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }

        // Fondo del nodo (Adaptado con alto contraste según tema)
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        if (esModoClaro) {
            ctx.fillStyle = esSeleccionado ? "#E0F2FE" : "#FFFFFF";
            ctx.shadowColor = "rgba(15, 23, 42, 0.12)";
            ctx.shadowBlur = 10;
            ctx.shadowOffsetY = 3;
        } else {
            ctx.fillStyle = esSeleccionado ? "rgba(0, 229, 255, 0.22)" : "rgba(15, 23, 42, 0.95)";
            ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
            ctx.shadowBlur = 10;
        }
        ctx.fill();

        // Borde del nodo
        ctx.strokeStyle = esSeleccionado
            ? (esModoClaro ? "#0284c7" : "#00E5FF")
            : (esModoClaro ? "#CBD5E1" : "rgba(148, 163, 184, 0.4)");
        ctx.lineWidth = esModoClaro ? 2 : 1.5;
        ctx.stroke();

        // Icono representativo por tipo de dispositivo
        ctx.font = "20px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let iconoDisp = "🖥️";
        if (n.device.tipo_dispositivo === "notebook") iconoDisp = "💻";
        else if (n.device.tipo_dispositivo === "smartphone") iconoDisp = "📱";
        else if (n.device.tipo_dispositivo === "tablet") iconoDisp = "📟";
        ctx.fillText(iconoDisp, n.x, n.y);

        // Corona si es Líder del grupo
        if (n.device.es_lider) {
            ctx.font = "16px sans-serif";
            ctx.fillText("👑", n.x, n.y - n.radius - 10);
        }

        // Punto de estado Online (verde) / Offline (gris)
        ctx.beginPath();
        ctx.arc(n.x + n.radius - 4, n.y + n.radius - 4, 6, 0, Math.PI * 2);
        ctx.fillStyle = enLinea ? "#10b981" : "#94a3b8";
        ctx.fill();
        ctx.strokeStyle = esModoClaro ? "#FFFFFF" : "#0b0f19";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Textos inferiores: Hostname e IP con máximo contraste
        ctx.font = "bold 12px 'Plus Jakarta Sans', sans-serif";
        ctx.fillStyle = esModoClaro ? "#0F172A" : "#F8FAFC";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const nombreTrunc = (n.device.nombre_host || n.device.direccion_ip).substring(0, 16);
        ctx.fillText(nombreTrunc, n.x, n.y + n.radius + 9);

        ctx.font = "600 11px monospace";
        ctx.fillStyle = esModoClaro ? "#475569" : "#94A3B8";
        ctx.fillText(n.device.direccion_ip, n.x, n.y + n.radius + 25);

        // Etiqueta del grupo si ya tiene
        if (n.device.grupo_nombre) {
            const grpTxt = `[${n.device.grupo_nombre.substring(0, 16)}]`;
            ctx.font = "bold 10px 'Plus Jakarta Sans', sans-serif";
            ctx.fillStyle = n.device.grupo_color || (esModoClaro ? "#4338CA" : "#818CF8");
            ctx.fillText(grpTxt, n.x, n.y + n.radius + 40);
        }

        ctx.restore();
    });

    // Actualizar contador y botón de acción en la barra
    actualizarToolbarSeleccionCanvas();
}

function actualizarToolbarSeleccionCanvas() {
    const badgeSel = document.querySelector("#badge-canvas-seleccionados");
    const btnCrear = document.querySelector("#btn-crear-grupo-seleccion");
    const count = dispositivosSeleccionadosCanvas.size;

    if (badgeSel) {
        badgeSel.textContent = `${count} seleccionado${count === 1 ? '' : 's'}`;
        badgeSel.style.color = count > 0 ? "#00E5FF" : "#818cf8";
    }

    if (btnCrear) {
        btnCrear.disabled = (count === 0);
        btnCrear.textContent = count > 0 ? `✨ Formar Grupo con Selección (${count})` : "✨ Formar Grupo con Seleccionados";
    }
}

// Manejo de Interacción con Mouse, Arrastre (Drag & Drop) y Teclado en el Lienzo
function setupLienzoInteracciones() {
    const canvas = document.querySelector("#canvas-grafo-grupos");
    if (!canvas) return;

    let dragStartX = 0;
    let dragStartY = 0;

    canvas.addEventListener("mousedown", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const nodoClickeado = nodosPosicionesCanvas.find(n => {
            const dist = Math.hypot(n.x - mouseX, n.y - mouseY);
            return dist <= n.radius + 6;
        });

        if (nodoClickeado) {
            nodoEnArrastre = nodoClickeado;
            arrastreHuboMovimiento = false;
            dragStartX = mouseX;
            dragStartY = mouseY;
        }
    });

    canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (nodoEnArrastre) {
            const dist = Math.hypot(mouseX - dragStartX, mouseY - dragStartY);
            if (dist > 3) {
                arrastreHuboMovimiento = true;
            }
            // Limitar al área visible del lienzo
            const clampedX = Math.max(nodoEnArrastre.radius + 10, Math.min(rect.width - nodoEnArrastre.radius - 10, mouseX));
            const clampedY = Math.max(nodoEnArrastre.radius + 10, Math.min(rect.height - nodoEnArrastre.radius - 50, mouseY));

            nodoEnArrastre.x = clampedX;
            nodoEnArrastre.y = clampedY;
            posicionesPersistentesNodos.set(nodoEnArrastre.device.id, { x: clampedX, y: clampedY });
            renderizarLienzoRedGrupos();
            return;
        }

        const hover = nodosPosicionesCanvas.some(n => Math.hypot(n.x - mouseX, n.y - mouseY) <= n.radius + 6);
        canvas.style.cursor = hover ? "pointer" : "default";
    });

    window.addEventListener("mouseup", () => {
        if (nodoEnArrastre) {
            nodoEnArrastre = null;
        }
    });

    canvas.addEventListener("click", (e) => {
        if (arrastreHuboMovimiento) {
            arrastreHuboMovimiento = false;
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const nodoClickeado = nodosPosicionesCanvas.find(n => {
            const dist = Math.hypot(n.x - mouseX, n.y - mouseY);
            return dist <= n.radius + 6;
        });

        if (nodoClickeado) {
            const devId = nodoClickeado.device.id;
            if (dispositivosSeleccionadosCanvas.has(devId)) {
                dispositivosSeleccionadosCanvas.delete(devId);
            } else {
                dispositivosSeleccionadosCanvas.add(devId);
            }
            nodoActivoCanvasIndex = nodoClickeado.index;
            renderizarLienzoRedGrupos();
        }
    });

    // Navegación con Flechas del Teclado
    window.addEventListener("keydown", (e) => {
        const tabGrupos = document.querySelector("#tab-grupos");
        if (!tabGrupos || !tabGrupos.classList.contains("active")) return;
        if (nodosPosicionesCanvas.length === 0) return;

        // Evitar interceptar si está escribiendo en un input
        if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;

        if (["ArrowRight", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            nodoActivoCanvasIndex = (nodoActivoCanvasIndex + 1) % nodosPosicionesCanvas.length;
            renderizarLienzoRedGrupos();
        } else if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            nodoActivoCanvasIndex = (nodoActivoCanvasIndex - 1 + nodosPosicionesCanvas.length) % nodosPosicionesCanvas.length;
            renderizarLienzoRedGrupos();
        } else if (["Enter", " "].includes(e.key)) {
            e.preventDefault();
            const nodo = nodosPosicionesCanvas[nodoActivoCanvasIndex];
            if (nodo) {
                const devId = nodo.device.id;
                if (dispositivosSeleccionadosCanvas.has(devId)) {
                    dispositivosSeleccionadosCanvas.delete(devId);
                } else {
                    dispositivosSeleccionadosCanvas.add(devId);
                }
                renderizarLienzoRedGrupos();
            }
        }
    });
}

// --- RENDERIZADO DE TARJETAS DE GRUPOS ---

function renderizarTarjetasGrupos() {
    const elGrid = document.querySelector("#grid-tarjetas-grupos");
    if (!elGrid) return;

    if (!cacheGrupos || cacheGrupos.length === 0) {
        elGrid.innerHTML = `
            <div class="activity-loading-placeholder" style="grid-column: 1 / -1; padding: 40px 20px;">
                <p>No hay grupos o mesas de trabajo configuradas aún.</p>
                <small style="color: var(--color-texto-suave);">Selecciona puestos en el mapa superior o haz clic en "+ Nuevo Grupo Manual".</small>
            </div>
        `;
        return;
    }

    elGrid.innerHTML = cacheGrupos.map(g => {
        const color = g.color || "#6366f1";
        const lider = g.lider;
        const miembros = g.miembros || [];

        const liderHtml = lider ? `
            <div class="group-leader-box">
                <div class="group-leader-info">
                    <span>👑 Líder:</span>
                    <strong style="color: #f59e0b;">${escapeHtml(lider.nombre_host)}</strong>
                </div>
                <span class="td-mono" style="font-size: 0.75rem; color: #f59e0b;">${escapeHtml(lider.direccion_ip)}</span>
            </div>
        ` : `
            <div class="group-leader-box" style="border-style: dashed; opacity: 0.7;">
                <span style="font-size: 0.8rem; color: var(--color-texto-suave);">Sin líder designado</span>
            </div>
        `;

        const miembrosChipsHtml = miembros.map(m => {
            const statusDot = m.en_linea ? `<span style="color: #10b981;">●</span>` : `<span style="color: #64748b;">○</span>`;
            const corona = m.es_lider ? `👑 ` : ``;
            return `
                <span class="group-member-chip" title="${escapeHtml(m.direccion_ip)} • ${escapeHtml(m.direccion_mac)}">
                    ${statusDot} ${corona}${escapeHtml(m.nombre_host)}
                </span>
            `;
        }).join("");

        const permArchivosBadge = g.permite_archivos_lider ? `📁 Archivos (Líder)` : ``;
        const permChatBadge = g.permite_chat_admin ? `🛡️ Chat Admin (Líder)` : ``;

        return `
            <div class="group-card" style="border-top: 3px solid ${color};">
                <div>
                    <div class="group-card-header">
                        <div class="group-card-title-wrap">
                            <span class="group-color-bullet" style="background: ${color}; color: ${color};"></span>
                            <h4 class="group-card-title">${escapeHtml(g.nombre)}</h4>
                        </div>
                        <span class="badge ${g.esta_activo ? 'badge-approved' : 'badge-rejected'}" style="font-size: 0.72rem;">
                            ${g.esta_activo ? 'Activo' : 'Pausado'}
                        </span>
                    </div>

                    ${liderHtml}

                    <div style="margin-bottom: 8px;">
                        <span style="font-size: 0.74rem; font-weight: 700; color: var(--color-texto-suave); text-transform: uppercase;">
                            Integrantes (${miembros.length}):
                        </span>
                    </div>
                    <div class="group-members-chips">
                        ${miembrosChipsHtml || '<span style="font-size: 0.75rem; color: var(--color-texto-suave);">Sin miembros</span>'}
                    </div>
                </div>

                <div class="group-card-footer">
                    <div class="group-perms-tags">
                        ${permArchivosBadge ? `<span class="badge" style="background: rgba(99, 102, 241, 0.1); font-size: 0.7rem;">${permArchivosBadge}</span>` : ''}
                        ${permChatBadge ? `<span class="badge" style="background: rgba(236, 72, 153, 0.1); font-size: 0.7rem;">${permChatBadge}</span>` : ''}
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button type="button" class="btn btn-secondary btn-editar-grupo" data-grupo-id="${g.id}" style="padding: 4px 10px; font-size: 0.78rem;">
                            ✏️ Editar
                        </button>
                        <button type="button" class="btn btn-logout btn-eliminar-grupo" data-grupo-id="${g.id}" style="padding: 4px 10px; font-size: 0.78rem;">
                            🗑️
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    // Listeners para botones de editar y eliminar grupo
    elGrid.querySelectorAll(".btn-editar-grupo").forEach(btn => {
        btn.addEventListener("click", () => {
            const gid = parseInt(btn.dataset.grupoId, 10);
            abrirModalEditarGrupo(gid);
        });
    });

    elGrid.querySelectorAll(".btn-eliminar-grupo").forEach(btn => {
        btn.addEventListener("click", () => {
            const gid = parseInt(btn.dataset.grupoId, 10);
            confirmarYEliminarGrupo(gid);
        });
    });
}

// --- MODAL DE CREACIÓN Y EDICIÓN DE GRUPOS ---

function abrirModalCrearGrupoConSeleccion() {
    const seleccionados = Array.from(dispositivosSeleccionadosCanvas);
    abrirModalConfigGrupo(null, seleccionados);
}

function abrirModalEditarGrupo(grupoId) {
    const grupo = cacheGrupos.find(g => g.id === grupoId);
    if (!grupo) return;
    const miembrosIds = (grupo.miembros || []).map(m => m.dispositivo_id);
    abrirModalConfigGrupo(grupo, miembrosIds);
}

function abrirModalConfigGrupo(grupoExistente = null, preseleccionadosIds = []) {
    const modal = document.querySelector("#modal-crear-editar-grupo");
    if (!modal) return;

    const inputId = document.querySelector("#modal-grupo-id-edit");
    const inputNombre = document.querySelector("#modal-grupo-nombre");
    const selectColor = document.querySelector("#modal-grupo-color");
    const selectLider = document.querySelector("#modal-grupo-lider");
    const checkArchivos = document.querySelector("#modal-check-archivos-lider");
    const checkChat = document.querySelector("#modal-check-chat-admin");
    const txtTitulo = document.querySelector("#modal-grupo-titulo");
    const elContenedorCheckboxes = document.querySelector("#modal-lista-dispositivos-checkboxes");

    if (grupoExistente) {
        txtTitulo.textContent = `✏️ Editar Mesa: ${grupoExistente.nombre}`;
        inputId.value = grupoExistente.id;
        inputNombre.value = grupoExistente.nombre;
        selectColor.value = grupoExistente.color || "#6366f1";
        checkArchivos.checked = grupoExistente.permite_archivos_lider;
        checkChat.checked = grupoExistente.permite_chat_admin;
    } else {
        txtTitulo.textContent = "✨ Configurar Nueva Mesa de Trabajo / Grupo";
        inputId.value = "";
        inputNombre.value = `Mesa ${cacheGrupos.length + 1} — Equipo`;
        selectColor.value = ["#6366f1", "#00E5FF", "#10b981", "#f59e0b", "#ec4899"][cacheGrupos.length % 5];
        checkArchivos.checked = true;
        checkChat.checked = true;
    }

    const setSeleccionados = new Set(preseleccionadosIds);

    // Renderizar lista de dispositivos con checkboxes
    elContenedorCheckboxes.innerHTML = cacheDispositivosCanvas.map(dev => {
        const isChecked = setSeleccionados.has(dev.id);
        const yaTieneOtroGrupo = dev.grupo_id && (!grupoExistente || dev.grupo_id !== grupoExistente.id);
        const avisoOtroGrupo = yaTieneOtroGrupo ? ` (Actualmente en: ${escapeHtml(dev.grupo_nombre)})` : ``;

        return `
            <label class="modal-device-select-item ${isChecked ? 'selected' : ''}" data-dev-id="${dev.id}">
                <input type="checkbox" class="chk-disp-grupo" value="${dev.id}" ${isChecked ? 'checked' : ''} />
                <span style="font-size: 1.1rem;">💻</span>
                <div style="flex: 1; font-size: 0.85rem;">
                    <strong>${escapeHtml(dev.nombre_host)}</strong>
                    <span style="color: var(--color-texto-suave); font-family: monospace; font-size: 0.78rem;">(${escapeHtml(dev.direccion_ip)})</span>
                    <span style="font-size: 0.75rem; color: #f59e0b;">${avisoOtroGrupo}</span>
                </div>
            </label>
        `;
    }).join("");

    // Función para actualizar dropdown de líder en base a los puestos marcados
    function actualizarSelectLider() {
        const marcadosIds = [];
        elContenedorCheckboxes.querySelectorAll(".chk-disp-grupo:checked").forEach(chk => {
            marcadosIds.push(parseInt(chk.value, 10));
        });

        const txtCount = document.querySelector("#txt-conteo-dispositivos-modal");
        if (txtCount) txtCount.textContent = `${marcadosIds.length} seleccionado${marcadosIds.length === 1 ? '' : 's'}`;

        const valorLiderPrevio = selectLider.value;
        selectLider.innerHTML = `<option value="">Selecciona un integrante para que sea el líder...</option>`;

        marcadosIds.forEach(id => {
            const dev = cacheDispositivosCanvas.find(d => d.id === id);
            if (dev) {
                const opt = document.createElement("option");
                opt.value = dev.id;
                opt.textContent = `👑 ${dev.nombre_host} (${dev.direccion_ip})`;
                selectLider.appendChild(opt);
            }
        });

        // Restaurar líder si corresponde
        if (grupoExistente && grupoExistente.lider && marcadosIds.includes(grupoExistente.lider.dispositivo_id)) {
            selectLider.value = grupoExistente.lider.dispositivo_id;
        } else if (valorLiderPrevio && marcadosIds.includes(parseInt(valorLiderPrevio, 10))) {
            selectLider.value = valorLiderPrevio;
        } else if (marcadosIds.length > 0) {
            selectLider.value = marcadosIds[0];
        }
    }

    elContenedorCheckboxes.querySelectorAll(".chk-disp-grupo").forEach(chk => {
        chk.addEventListener("change", (e) => {
            const item = e.target.closest(".modal-device-select-item");
            if (item) item.classList.toggle("selected", e.target.checked);
            actualizarSelectLider();
        });
    });

    actualizarSelectLider();
    modal.style.display = "flex";
}

function cerrarModalGrupo() {
    const modal = document.querySelector("#modal-crear-editar-grupo");
    if (modal) modal.style.display = "none";
}

async function guardarGrupoSubmit(e) {
    e.preventDefault();
    const inputId = document.querySelector("#modal-grupo-id-edit");
    const inputNombre = document.querySelector("#modal-grupo-nombre");
    const selectColor = document.querySelector("#modal-grupo-color");
    const selectLider = document.querySelector("#modal-grupo-lider");
    const checkArchivos = document.querySelector("#modal-check-archivos-lider");
    const checkChat = document.querySelector("#modal-check-chat-admin");

    const marcadosIds = [];
    document.querySelectorAll(".chk-disp-grupo:checked").forEach(chk => {
        marcadosIds.push(parseInt(chk.value, 10));
    });

    if (marcadosIds.length === 0) {
        alert("Debes seleccionar al menos 1 dispositivo para conformar el grupo.");
        return;
    }

    const body = {
        nombre: inputNombre.value.trim(),
        color: selectColor.value,
        dispositivos_ids: marcadosIds,
        lider_dispositivo_id: selectLider.value ? parseInt(selectLider.value, 10) : null,
        permite_archivos_lider: checkArchivos.checked,
        permite_chat_admin: checkChat.checked,
        esta_activo: true,
    };

    try {
        const esEdicion = !!inputId.value;
        const url = esEdicion ? `${API_URL}/groups/${inputId.value}` : `${API_URL}/groups`;
        const method = esEdicion ? "PUT" : "POST";

        const res = await fetch(url, {
            method: method,
            headers: getAuthHeaders(),
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || "Error al guardar el grupo");
        }

        cerrarModalGrupo();
        dispositivosSeleccionadosCanvas.clear();
        await cargarModuloGrupos();
    } catch (err) {
        console.error("Error al guardar grupo:", err);
        alert(err.message || "No se pudo guardar el grupo.");
    }
}

async function confirmarYEliminarGrupo(grupoId) {
    const grupo = cacheGrupos.find(g => g.id === grupoId);
    const nombre = grupo ? grupo.nombre : "este grupo";
    if (!confirm(`¿Estás seguro de que deseas eliminar '${nombre}'? Los dispositivos quedarán desvinculados.`)) {
        return;
    }

    try {
        const res = await fetch(`${API_URL}/groups/${grupoId}`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error("Error al eliminar grupo");

        dispositivosSeleccionadosCanvas.clear();
        await cargarModuloGrupos();
    } catch (err) {
        console.error("Error al eliminar grupo:", err);
        alert("No se pudo eliminar el grupo.");
    }
}

// Configuración de listeners del módulo de grupos
function setupGruposListeners() {
    const btnToggleIso = document.querySelector("#btn-toggle-modo-aislamiento");
    if (btnToggleIso) btnToggleIso.addEventListener("click", alternarModoAislamientoGlobal);

    const btnCrearSel = document.querySelector("#btn-crear-grupo-seleccion");
    if (btnCrearSel) btnCrearSel.addEventListener("click", abrirModalCrearGrupoConSeleccion);

    const btnCrearManual = document.querySelector("#btn-abrir-crear-grupo-manual");
    if (btnCrearManual) btnCrearManual.addEventListener("click", () => abrirModalConfigGrupo(null, []));

    const btnLimpiar = document.querySelector("#btn-limpiar-seleccion-canvas");
    if (btnLimpiar) {
        btnLimpiar.addEventListener("click", () => {
            dispositivosSeleccionadosCanvas.clear();
            renderizarLienzoRedGrupos();
        });
    }

    const btnRecargar = document.querySelector("#btn-recargar-canvas-grupos");
    if (btnRecargar) btnRecargar.addEventListener("click", () => cargarModuloGrupos());

    const btnCerrar = document.querySelector("#btn-cerrar-modal-grupo");
    const btnCancelar = document.querySelector("#btn-cancelar-modal-grupo");
    if (btnCerrar) btnCerrar.addEventListener("click", cerrarModalGrupo);
    if (btnCancelar) btnCancelar.addEventListener("click", cerrarModalGrupo);

    const formGrupo = document.querySelector("#form-crear-editar-grupo");
    if (formGrupo) formGrupo.addEventListener("submit", guardarGrupoSubmit);

    setupLienzoInteracciones();
}

setupGruposListeners();
cargarModuloGrupos(true);

setInterval(async () => {
    verificarEstadoMikrotik();
    await sincronizarDispositivosSilencioso();
    await cargarSesionesActivas();
    await cargarDominiosBloqueados();

    const tabAct = document.querySelector("#tab-actividad");
    if (tabAct && tabAct.classList.contains("active")) {
        await cargarActividadDispositivos(true);
    }

    const tabGrp = document.querySelector("#tab-grupos");
    if (tabGrp && tabGrp.classList.contains("active")) {
        await cargarModuloGrupos(true);
    }

    const tabMsg = document.querySelector("#tab-mensajes");
    if (tabMsg && tabMsg.classList.contains("active")) {
        const btnInbox = document.querySelector("#btn-subtab-inbox");
        if (btnInbox && btnInbox.classList.contains("active")) {
            await cargarBandejaMensajesAdmin(true);
        }
    } else {
        // En cualquier otra pestaña, sondear periódicamente para alertar si entra un mensaje de una estación
        await cargarBandejaMensajesAdmin(true);
    }
}, 5000);

