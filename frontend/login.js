const API_URL = "http://localhost:8000";

const formLogin = document.querySelector("#form-login");
const inputUsuario = document.querySelector("#input-usuario");
const inputClave = document.querySelector("#input-clave");
const mensajeError = document.querySelector("#mensaje-error");
const btnLogin = document.querySelector("#btn-login");

// Si ya tiene sesión activa, redirigir según su rol
(function verificarSesionExistente() {
    const token = localStorage.getItem("lab_token");
    const usuarioStr = localStorage.getItem("lab_usuario");
    if (token && usuarioStr) {
        try {
            const usuario = JSON.parse(usuarioStr);
            if (usuario.rol === "admin") {
                window.location.href = "index.html";
            } else {
                window.location.href = "portal.html";
            }
        } catch (e) {
            localStorage.clear();
        }
    }
})();

formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    mensajeError.style.display = "none";
    mensajeError.textContent = "";
    btnLogin.disabled = true;
    btnLogin.textContent = "Verificando...";

    const usuario = inputUsuario.value.trim();
    const clave = inputClave.value;

    try {
        const respuesta = await fetch(`${API_URL}/auth/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                nombre_usuario: usuario,
                clave: clave,
            }),
        });

        const data = await respuesta.json();

        if (!respuesta.ok) {
            mensajeError.textContent = data.detail || "Error al iniciar sesión";
            mensajeError.style.display = "block";
            btnLogin.disabled = false;
            btnLogin.textContent = "Ingresar al Sistema";
            return;
        }

        // Guardar token y datos del usuario
        localStorage.setItem("lab_token", data.access_token);
        localStorage.setItem("lab_usuario", JSON.stringify(data.usuario));

        // Redirección según rol
        if (data.usuario.rol === "admin") {
            window.location.href = "index.html";
        } else {
            window.location.href = "portal.html";
        }
    } catch (error) {
        console.error("Error de conexión:", error);
        mensajeError.textContent = "No se pudo conectar con el servidor backend (¿Docker está corriendo?)";
        mensajeError.style.display = "block";
        btnLogin.disabled = false;
        btnLogin.textContent = "Ingresar al Sistema";
    }
});
