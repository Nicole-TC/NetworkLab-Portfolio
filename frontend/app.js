const API_URL = "http://localhost:8000";

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

const elTiempoDefault = document.querySelector("#input-tiempo-default");
const elVelocidadDefault = document.querySelector("#select-velocidad-default");
const elInputDominio = document.querySelector("#input-dominio-bloquear");
const elSelectCategoria = document.querySelector("#select-categoria-bloquear");
const elBtnBloquearDominio = document.querySelector("#btn-bloquear-dominio");

// KPIs
const elKpiDispositivos = document.querySelector("#kpi-dispositivos");
const elKpiDispositivosSub = document.querySelector("#kpi-dispositivos-sub");
const elKpiSesionesActivas = document.querySelector("#kpi-sesiones-activas");
const elKpiSesionesSub = document.querySelector("#kpi-sesiones-sub");
const elKpiHoras = document.querySelector("#kpi-horas");
const elKpiDominios = document.querySelector("#kpi-dominios");

let cacheSesiones = [];
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

// --- Sistema de Pestañas (Tabs) ---
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
        }
    });
});

// --- 1. Dispositivos ---

async function cargarDispositivos() {
    try {
        const respuesta = await fetch(`${API_URL}/devices/`, { headers: getAuthHeaders() });
        const dispositivos = await respuesta.json();

        elTablaDispositivos.innerHTML = "";

        if (dispositivos.length === 0) {
            elMensajeDispositivos.textContent =
                'No hay dispositivos registrados todavía. Probá "Sincronizar dispositivos".';
            return;
        }

        elMensajeDispositivos.textContent = "";

        for (const dispositivo of dispositivos) {
            const estado = dispositivo.estado || dispositivo.status;
            const hostname = dispositivo.nombre_host || dispositivo.hostname || "(sin nombre)";
            const ip = dispositivo.direccion_ip || dispositivo.ip_address || "—";
            const mac = dispositivo.direccion_mac || dispositivo.mac_address || "—";
            const ultimaActividad = dispositivo.ultima_actividad || dispositivo.last_seen;
            const limiteVelocidad = dispositivo.limite_velocidad_mbps !== undefined 
                ? dispositivo.limite_velocidad_mbps 
                : dispositivo.bandwidth_limit_mbps;

            let accionesHtml = "";
            if (estado === "pendiente" || estado === "pending" || estado === "rechazado" || estado === "rejected") {
                accionesHtml = `
                  <div class="acciones-container">
                    <input 
                      type="number" 
                      min="1" 
                      id="tiempo-dev-${dispositivo.id}" 
                      placeholder="Min (15)" 
                      class="input-tiempo input-tiempo-row" 
                      title="Tiempo límite en minutos"
                    />
                    <select id="velocidad-dev-${dispositivo.id}" class="select-velocidad select-velocidad-row" title="Límite de velocidad QoS">
                      <option value="">Vel: Ilim</option>
                      <option value="2">2 Mbps</option>
                      <option value="5">5 Mbps</option>
                      <option value="10">10 Mbps</option>
                      <option value="20">20 Mbps</option>
                    </select>
                    <input 
                      type="text" 
                      id="clave-dev-${dispositivo.id}" 
                      placeholder="PIN (1234)" 
                      class="input-tiempo input-tiempo-row" 
                      style="width: 80px;"
                      title="Contraseña o PIN para el alumno al ingresar al portal"
                    />
                    <button class="btn btn-aprobar" data-id="${dispositivo.id}" data-accion="approve" data-ip="${ip}">
                      Aprobar
                    </button>
                    ${(estado === "pendiente" || estado === "pending") ? `
                      <button class="btn btn-rechazar" data-id="${dispositivo.id}" data-accion="reject">
                        Rechazar
                      </button>
                    ` : ""}
                  </div>
                `;
            } else if (estado === "aprobado" || estado === "approved") {
                accionesHtml = `
                  <div class="acciones-container">
                    <select class="select-velocidad select-velocidad-row select-change-speed" data-id="${dispositivo.id}" title="Cambiar límite de velocidad QoS">
                      <option value="" ${!limiteVelocidad ? "selected" : ""}>Vel: Ilim</option>
                      <option value="2" ${limiteVelocidad === 2 ? "selected" : ""}>2 Mbps</option>
                      <option value="5" ${limiteVelocidad === 5 ? "selected" : ""}>5 Mbps</option>
                      <option value="10" ${limiteVelocidad === 10 ? "selected" : ""}>10 Mbps</option>
                      <option value="20" ${limiteVelocidad === 20 ? "selected" : ""}>20 Mbps</option>
                    </select>
                    <button class="btn btn-rechazar" data-id="${dispositivo.id}" data-accion="reject">
                      Rechazar / Bloquear
                    </button>
                  </div>
                `;
            }

            const fila = document.createElement("tr");
            fila.innerHTML = `
                <td>${badgePorEstado[estado] || estado}</td>
                <td>${hostname}</td>
                <td>${ip}</td>
                <td>${mac}</td>
                <td>${formatearFecha(ultimaActividad)}</td>
                <td>${accionesHtml}</td>
            `;
            elTablaDispositivos.appendChild(fila);
        }

        marcarConectado();
    } catch (error) {
        marcarDesconectado();
        console.error("Error cargando dispositivos:", error);
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
    elTablaSesiones.innerHTML = "";

    if (cacheSesiones.length === 0) {
        elMensajeSesiones.textContent =
            'No hay sesiones activas. Probá "Sincronizar sesiones" con algún dispositivo aprobado y conectado.';
        return;
    }

    elMensajeSesiones.textContent = "";

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

        const badgeQos = limiteVelocidad
            ? `<span class="badge badge-qos">⚡ ${limiteVelocidad} Mbps</span>`
            : `<span class="badge badge-qos-unlimited">⚡ Ilimitada</span>`;

        const fila = document.createElement("tr");
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
        <td>${badgeQos}</td>
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
    }
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

async function cargarDominiosBloqueados() {
    try {
        const respuesta = await fetch(`${API_URL}/filter/domains`, { headers: getAuthHeaders() });
        const dominios = await respuesta.json();

        elTablaDominios.innerHTML = "";

        if (dominios.length === 0) {
            elMensajeDominios.textContent = "No hay dominios bloqueados en este momento.";
            return;
        }

        elMensajeDominios.textContent = "";

        for (const d of dominios) {
            const dom = d.dominio || d.domain;
            const cat = d.categoria || d.category || "General";
            const fecha = d.fecha_creacion || d.created_at;

            const fila = document.createElement("tr");
            fila.innerHTML = `
              <td><strong>${dom}</strong></td>
              <td><span class="badge badge-category">${cat}</span></td>
              <td>${formatearFecha(fecha)}</td>
              <td><span class="badge badge-dns-active">🟢 Bloqueado en MikroTik</span></td>
              <td>
                <button class="btn btn-desbloquear" data-id="${d.id}" data-accion="unblock-domain">
                  Desbloquear
                </button>
              </td>
            `;
            elTablaDominios.appendChild(fila);
        }
    } catch (error) {
        console.error("Error cargando dominios bloqueados:", error);
    }
}

async function bloquearDominio(dominio, categoria = "General") {
    if (!dominio) return;
    try {
        const resp = await fetch(`${API_URL}/filter/domains`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ dominio: dominio, categoria: categoria }),
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

    chartConsumoInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels.length > 0 ? labels : ["Sin datos"],
            datasets: [
                {
                    label: "Horas de Conexión",
                    data: horas.length > 0 ? horas : [0],
                    backgroundColor: "rgba(56, 189, 248, 0.7)",
                    borderColor: "#38bdf8",
                    borderWidth: 1,
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
                    ticks: { color: "#94a3b8" },
                    grid: { color: "rgba(255, 255, 255, 0.05)" },
                },
                x: {
                    ticks: { color: "#94a3b8" },
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

    chartCategoriasInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: labels.length > 0 ? labels : ["Sin dominios"],
            datasets: [
                {
                    data: cantidades.length > 0 ? cantidades : [1],
                    backgroundColor: [
                        "#f87171",
                        "#fbbf24",
                        "#38bdf8",
                        "#a78bfa",
                        "#34d399",
                        "#94a3b8",
                    ],
                    borderWidth: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "right",
                    labels: { color: "#cbd5e1", boxWidth: 14 },
                },
            },
        },
    });
}

// --- 5. Gestión de Usuarios ---

async function cargarUsuarios() {
    try {
        const resp = await fetch(`${API_URL}/auth/usuarios`, { headers: getAuthHeaders() });
        if (!resp.ok) return;
        const usuarios = await resp.json();

        elTablaUsuarios.innerHTML = "";

        if (usuarios.length === 0) {
            elMensajeUsuarios.textContent = "No hay usuarios registrados.";
            return;
        }

        elMensajeUsuarios.textContent = "";

        for (const u of usuarios) {
            const esAdmin = u.rol === "admin";
            const badgeRol = esAdmin
                ? '<span class="user-role-badge role-admin">ADMIN</span>'
                : '<span class="user-role-badge role-alumno">ALUMNO</span>';

            const fila = document.createElement("tr");
            fila.innerHTML = `
              <td>${u.id}</td>
              <td><strong>${u.nombre_usuario}</strong></td>
              <td>${u.nombre_completo || "—"}</td>
              <td>${badgeRol}</td>
              <td>${formatearFecha(u.creado_en)}</td>
              <td>
                ${u.id !== usuarioActual.id ? `
                  <button class="btn btn-rechazar btn-eliminar-usuario" data-id="${u.id}">
                    Eliminar
                  </button>
                ` : '<span style="color: var(--color-texto-suave); font-size: 0.8rem;">Sesión Actual</span>'}
              </td>
            `;
            elTablaUsuarios.appendChild(fila);
        }
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

            let ipDispositivo = botonEl && botonEl.dataset.ip ? botonEl.dataset.ip : "";

            const params = new URLSearchParams();
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

// Delegación de eventos para la tabla de dispositivos
elTablaDispositivos.addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-accion]");
    if (!boton) return;
    aprobarORechazar(boton.dataset.id, boton.dataset.accion, boton);
});

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
        if (!dom) {
            alert("Por favor escribe un dominio (ej: youtube.com)");
            return;
        }
        bloquearDominio(dom, cat);
        if (elInputDominio) elInputDominio.value = "";
    });
}

// Botones de bloqueo rápido
document.querySelectorAll(".btn-quick-block").forEach((btn) => {
    btn.addEventListener("click", () => {
        bloquearDominio(btn.dataset.domain, btn.dataset.cat);
    });
});

document.querySelector("#btn-sync-devices").addEventListener("click", async () => {
    try {
        await fetch(`${API_URL}/devices/sync`, { method: "POST", headers: getAuthHeaders() });
        await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });
    } catch (error) {
        console.error("Error sincronizando dispositivos:", error);
    } finally {
        await cargarDispositivos();
        await cargarSesionesActivas();
    }
});

document.querySelector("#btn-sync-sessions").addEventListener("click", async () => {
    try {
        await fetch(`${API_URL}/sessions/sync`, { method: "POST", headers: getAuthHeaders() });
    } catch (error) {
        console.error("Error sincronizando sesiones:", error);
    } finally {
        await cargarSesionesActivas();
    }
});

const btnRefrescarStats = document.querySelector("#btn-refrescar-stats");
if (btnRefrescarStats) {
    btnRefrescarStats.addEventListener("click", cargarEstadisticas);
}

// Carga inicial y actualización periódica
cargarDispositivos();
cargarSesionesActivas();
cargarDominiosBloqueados();

setInterval(() => {
    cargarDispositivos();
    cargarSesionesActivas();
    cargarDominiosBloqueados();
}, 10000);
