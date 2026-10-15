# 📁 Estructura del Proyecto, Funcionalidades por Archivo y Recursos Utilizados

Este documento detalla en profundidad la organización del código fuente del proyecto **NetworkLab (Laboratorio2-Tacuri)**, explicando la responsabilidad de cada archivo, sus funciones principales, así como todas las librerías, dependencias y recursos de diseño utilizados junto con la justificación de su elección.

---

## 📑 Índice de Contenidos

1. [Mapa General del Repositorio](#1-mapa-general-del-repositorio)
2. [Desglose Archivo por Archivo: Raíz y Despliegue](#2-desglose-archivo-por-archivo-raíz-y-despliegue)
3. [Desglose Archivo por Archivo: Backend (FastAPI & RouterOS)](#3-desglose-archivo-por-archivo-backend-fastapi--routeros)
   - [Núcleo y Configuración](#núcleo-y-configuración)
   - [Enrutadores API (`app/routers/`)](#enrutadores-api-approuters)
4. [Desglose Archivo por Archivo: Frontend (SPA & Portal Cautivo)](#4-desglose-archivo-por-archivo-frontend-spa--portal-cautivo)
5. [Librerías y Recursos Utilizados (¿Por qué se eligieron?)](#5-librerías-y-recursos-utilizados-por-qué-se-eligieron)
   - [Tecnologías y Librerías del Backend](#tecnologías-y-librerías-del-backend)
   - [Tecnologías y Librerías del Frontend](#tecnologías-y-librerías-del-frontend)
   - [Recursos de Estilo, Audio y PWA](#recursos-de-estilo-audio-y-pwa)
6. [Flujos Lógicos Integrados de la Plataforma](#6-flujos-lógicos-integrados-de-la-plataforma)

---

## 1. Mapa General del Repositorio

```
Laboratorio2-Tacuri/
├── .gitignore                       # Exclusiones de Git (claves, __pycache__, etc.)
├── docker-compose.yml               # Orquestador multi-contenedor (Postgres, Backend, Nginx)
├── README.md                        # Documentación general y guía de instalación
├── ESTRUCTURA_Y_ARCHIVOS.md         # (Este documento) Explicación técnica detallada
│
├── docs/
│   └── hotspot-setup.md             # Guía paso a paso de RouterOS Hotspot
│
├── backend/
│   ├── Dockerfile                   # Imagen Docker para el entorno Python 3.11
│   ├── requirements.txt             # Dependencias Python del backend
│   └── app/
│       ├── __init__.py              # Marcador de módulo Python
│       ├── main.py                  # Entrada FastAPI, ciclo de vida y migraciones SQL
│       ├── config.py                # Lectura validada de variables de entorno
│       ├── database.py              # Configuración del motor SQLAlchemy y sesiones
│       ├── models.py                # Modelos ORM (tablas y esquemas relacionales)
│       ├── auth.py                  # Utilidades de seguridad (JWT, Bcrypt hashing)
│       ├── routeros_client.py       # Conector y orquestador API para MikroTik
│       ├── uploads/                 # Almacenamiento local de archivos compartidos
│       └── routers/
│           ├── auth.py              # Endpoints de inicio de sesión y usuarios
│           ├── devices.py           # Endpoints de descubrimiento, aprobación y DHCP
│           ├── sessions.py          # Endpoints de sesiones de red y tiempos
│           ├── stats.py             # Endpoints de analítica y métricas para gráficos
│           ├── web_filter.py        # Endpoints de filtrado web (DNS lista blanca)
│           ├── roles.py             # Endpoints de políticas y perfiles de conexión
│           ├── files.py             # Endpoints de subida, streaming y descarga
│           ├── messages.py          # Endpoints de anuncios y confirmación x/y
│           └── portal.py            # Endpoints del portal cautivo y telemetría
│
└── frontend/
    ├── index.html                   # Panel administrativo principal del docente
    ├── app.js                       # Lógica SPA del panel docente (DOM, APIs, Chart.js)
    ├── login.html                   # Pantalla de acceso seguro para el docente/admin
    ├── login.js                     # Control de autenticación y almacenamiento del JWT
    ├── portal.html                  # Portal cautivo / sala de espera del alumno
    ├── portal.js                    # Lógica del alumno (reloj, Service Worker, PDF.js)
    ├── style.css                    # Sistema de diseño completo (Modo Oscuro & Claro)
    ├── sw.js                        # Service Worker para notificaciones nativas push
    ├── chart.js                     # Librería Chart.js empaquetada localmente
    ├── pdf.min.js                   # Motor PDF.js para previsualización directa
    ├── pdf.worker.min.js            # Hilo de renderizado para PDF.js
    ├── favicon.ico                  # Icono de navegador multiresolución
    ├── favicon.png                  # Icono PNG de alta densidad
    └── favicon.svg                  # Icono vectorial escalable
```

---

## 2. Desglose Archivo por Archivo: Raíz y Despliegue

### `docker-compose.yml`
* **Propósito**: Automatiza el despliegue de toda la solución en tres contenedores vinculados en una red interna privada.
* **Servicios definidos**:
  1. `db`: Base de datos relacional **PostgreSQL 16 Alpine**, con volumen persistente (`db_data`) y healthcheck automático (`pg_isready`).
  2. `backend`: Contenedor Python FastAPI. Espera a que PostgreSQL esté sano (`condition: service_healthy`) antes de iniciar. Mapea el puerto `8000`.
  3. `frontend`: Servidor web **Nginx Alpine**, montando los archivos estáticos en modo solo lectura (`ro`) en el puerto `3000`.

### `.env.example` y `.env`
* **Propósito**: Centralizar parámetros de configuración sensibles sin exponerlos en el repositorio Git.
* **Contenido**: Dirección IP y credenciales del MikroTik (`ROUTEROS_HOST`, `ROUTEROS_USER`, etc.), credenciales de Postgres, puertos y listas de MACs de administradores exentas de restricciones.

### `docs/hotspot-setup.md`
* **Propósito**: Manual técnico con comandos de RouterOS y capturas lógicas para configurar Hotspot, bypass de MACs y redirecciones hacia el servidor local.

---

## 3. Desglose Archivo por Archivo: Backend (FastAPI & RouterOS)

### Núcleo y Configuración

#### `backend/app/main.py`
* **Responsabilidad**: Punto de entrada de la aplicación FastAPI.
* **Funcionalidades clave**:
  * Define la instancia `FastAPI` con título, descripción y metadatos de documentación Swagger (`/docs`).
  * Configura **CORS** (`CORSMiddleware`) permitiendo peticiones desde cualquier origen local para facilitar el acceso desde la red del aula.
  * **Lifespan / Migraciones al inicio (`startup`)**: Ejecuta sentencias SQL DDL automáticas (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`) para asegurar que las tablas `dominios_bloqueados`, `politicas_roles`, `archivos_compartidos`, `mensajes_red` y `mensaje_lecturas` existan sin necesidad de herramientas complejas como Alembic.
  * Cierra automáticamente sesiones huérfanas de más de 12 horas.
  * Registra todos los enrutadores de la carpeta `routers/`.

#### `backend/app/config.py`
* **Responsabilidad**: Mapea y valida las variables de entorno mediante `pydantic-settings`.
* **Clase `Settings`**: Centraliza el acceso seguro a variables como `DATABASE_URL`, `ROUTEROS_HOST`, `ROUTEROS_PASSWORD`, `TIMEZONE` y `ADMIN_MACS`.

#### `backend/app/database.py`
* **Responsabilidad**: Gestión de la conexión a la base de datos PostgreSQL.
* **Componentes**: Crea el `engine` de SQLAlchemy, la fábrica de sesiones `sessionmaker` y la función inyectable `get_db()` usada como dependencia (`Depends`) en cada endpoint para garantizar que cada petición abra y cierre su sesión limpia.

#### `backend/app/models.py`
* **Responsabilidad**: Declaración de los modelos ORM de la base de datos.
* **Modelos**:
  * `Dispositivo`: Registra equipos con su IP, MAC, hostname, rol (`nivel_1`, `nivel_2`, `admin`), estado (`pending`, `aprobado`, `rechazado`), tiempos de última conexión e indicador de IP estática.
  * `Sesion`: Historial de conexiones. Guarda fecha de inicio, fin, duración en segundos, `tiempo_activo_segundos` (calculado por tráfico en el router), bytes de subida y bajada.
  * `Usuario`: Usuarios administrativos del sistema con contraseña hasheada en formato Bcrypt.
  * `DominioBloqueado`: Entradas de filtrado web con tipo (`blanca` o `negra`), categoría, alcance (`todos`, `nivel_1`, etc.) y estado activo.
  * `PoliticaRol`: Políticas predeterminadas por rol (tiempo de sesión, ancho de banda en Mbps, exención de filtro).
  * `ArchivoCompartido`: Registro de archivos compartidos (nombre original, nombre hash en disco, tamaño en bytes, tipo MIME, rol destinatario).
  * `MensajeRed`: Comunicados emitidos por el docente (título, contenido, tipo `info`/`aviso`/`urgente`, alcance).
  * `MensajeLectura`: Confirmaciones individuales de lectura enviadas por cada equipo alumno (relación en cascada con `MensajeRed`).

#### `backend/app/auth.py`
* **Responsabilidad**: Criptografía y tokens de seguridad.
* **Funciones**:
  * `verify_password()` y `get_password_hash()`: Utilizan la librería `passlib` con algoritmo `bcrypt` para almacenamiento seguro sin texto plano.
  * `create_access_token()`: Genera tokens JWT firmados con tiempo de expiración.
  * `get_current_user()`: Middleware de dependencia para proteger rutas administrativas verificando el encabezado `Authorization: Bearer <token>`.

#### `backend/app/routeros_client.py`
* **Responsabilidad**: El "cerebro" de integración con el hardware MikroTik.
* **Funciones destacadas**:
  * `conectar_mikrotik()`: Establece conexión TCP mediante el puerto API (8728) usando `librouteros`.
  * `sincronizar_leases_dhcp()`: Lee la tabla `/ip/dhcp-server/lease` del router y detecta nuevos dispositivos en la red.
  * `hacer_lease_estatico()` y `asignar_ip_unica_estatica()`: Convierte una concesión dinámica en una reserva estática vinculada a la dirección MAC del equipo, evitando que el router reasigne la misma IP a otro dispositivo.
  * `actualizar_regla_firewall()` / `bloquear_dispositivo()` / `desbloquear_dispositivo()`: Agrega o remueve la IP de la lista `/ip/firewall/address-list` (`blocked-devices`), cortando o permitiendo el acceso a internet a nivel kernel en el router.
  * `configurar_limite_ancho_banda()` / `eliminar_limite_ancho_banda()`: Crea o modifica colas simples en `/queue/simple` para aplicar límites QoS en megabits por segundo (ej. `5M/10M`).
  * `sincronizar_filtro_dns()`: Inyecta o limpia registros en `/ip/dns/static`. En modo lista blanca, redirige dominios no autorizados a una dirección nula (`0.0.0.0` o sinkhole).
  * `obtener_recursos_sistema()`: Consulta `/system/resource` para obtener CPU, memoria libre, versión de RouterOS y tiempo activo (`uptime`).

---

### Enrutadores API (`app/routers/`)

* **`routers/devices.py`**:
  * `POST /devices/sync`: Sincroniza en tiempo real los dispositivos conectados al router y registra automáticamente nuevos equipos en estado "pendiente".
  * `POST /devices/{id}/approve`: Aprueba el equipo, aplica su política QoS en MikroTik, crea su reserva estática y abre su sesión de red.
  * `POST /devices/{id}/reject`: Bloquea el dispositivo en el firewall del router.
  * `PUT /devices/{id}`: Permite modificar el rol, alias o dirección IP asignada a un dispositivo.
* **`routers/sessions.py`**:
  * `POST /sessions/sync`: Audita las sesiones activas, consulta el tráfico generado en el router para calcular actividad real vs inactividad, y finaliza sesiones que han excedido el tiempo permitido.
  * `GET /sessions/active`: Retorna las sesiones en curso.
  * `GET /sessions/device/{id}/total-time`: Retorna los tiempos acumulados por equipo.
* **`routers/stats.py`**:
  * `GET /stats/dashboard`: Entrega todas las métricas agrupadas para las tarjetas KPI y gráficos de Chart.js (equipos aprobados, sesiones de hoy, consumo promedio, tiempo activo del router).
  * `GET /stats/devices/activity`: Desglose individual de horas activas vs horas inactivas por equipo.
* **`routers/web_filter.py`**:
  * `GET /web-filter/`: Lista de dominios con sus categorías y alcances.
  * `POST /web-filter/`: Creación de regla (ej. `wikipedia.org` permitido). Aplica sincronización directa en el DNS de MikroTik.
  * `PUT /web-filter/{id}`: Edición de alcance y categoría de un dominio existente.
  * `DELETE /web-filter/{id}`: Eliminación de regla y limpieza en el router.
* **`routers/roles.py`**:
  * `GET /roles/` y `PUT /roles/{rol}`: Consulta y ajuste de tiempos permitidos y límites de velocidad para cada nivel de usuario.
* **`routers/files.py`**:
  * `POST /files/upload`: Recepción de archivos mediante `UploadFile`, guardado con nombre único en disco y registro en base de datos.
  * `GET /files/{id}/download`: Descarga forzada del material.
  * `GET /files/{id}/view`: Transmisión en streaming (`inline`) con tipo MIME adecuado para visualización directa en PDF.js o navegadores.
* **`routers/messages.py`**:
  * `POST /messages/`: Publicación de anuncios en la red por parte del docente.
  * `GET /messages/`: Listado con cálculo dinámico del contador de lectura `total_leidos / total_conectados` ($x/y$).
  * `GET /messages/active`: Consulta filtrada usada por el portal del alumno (excluye mensajes ya leídos por la IP consultante).
  * `POST /messages/{id}/read`: Registro persistente de confirmación de lectura.
* **`routers/portal.py`**:
  * `GET /portal/status`: Endpoint consumido cada 3 segundos por `portal.js`. Detecta la IP del cliente y le informa su estado (`espera`, `aprobado`, `expirada`), tiempo restante de conexión, QoS asignado y rol.
  * `POST /portal/request-reaccess`: Solicitud de renovación de tiempo de conexión enviada por un alumno expirado.
* **`routers/auth.py`**:
  * `POST /auth/token`: Validación de credenciales de docente/administrador y emisión de token JWT.
  * `GET /auth/me`: Verificación de sesión activa del operador.

---

## 4. Desglose Archivo por Archivo: Frontend (SPA & Portal Cautivo)

### `frontend/index.html`
* **Responsabilidad**: Interfaz gráfica del panel de control del docente / administrador.
* **Estructura visual**:
  * Encabezado con estado del router, tiempo activo (`uptime`), usuario activo, selector de tema (claro/oscuro) y botón de cierre de sesión.
  * Navegación por pestañas:
    * **Dispositivos**: Solicitudes pendientes de aprobación, lista de equipos en red con controles de rol y bloqueo manual.
    * **Estadísticas**: Indicadores KPI, gráfico temporal de conexiones, gráfico de actividad vs tiempo muerto, tarjetas detalladas por equipo.
    * **Filtrado Web**: Formulario con botones de sugerencias educativas rápidas (Wikipedia, Classroom, GitHub), tabla de dominios con opción de edición rápida.
    * **Roles**: Configuración de velocidad QoS (Mbps) y tiempo límite para Nivel 1 y Nivel 2.
    * **Archivos**: Zona arrastrar y soltar (`dropzone`), listado de materiales y botón de previsualización.
    * **Mensajería**: Emisión de comunicados con selector de urgencia y tabla con confirmación de lectura `x/y`.

### `frontend/app.js`
* **Responsabilidad**: Lógica de cliente para el panel de administración.
* **Aspectos técnicos**:
  * Manejo del token JWT en `localStorage`.
  * Bucle de sincronización periódica cada 3-5 segundos sin recargar la página.
  * Inicialización y actualización dinámica de gráficos con **Chart.js** (destrucción y re-renderizado sin memory leaks).
  * Filtro interactivo de estadísticas por dispositivo individual.
  * Modales para edición de dispositivos, dominios y visor de archivos.

### `frontend/portal.html`
* **Responsabilidad**: Interfaz del usuario final (alumno / estación de trabajo).
* **Vistas condicionales**:
  * **Vista 0 (Cargando)**: Pantalla inicial mientras se detecta la IP y estado contra el router.
  * **Vista 1 (Espera / Cautiva)**: Informa al estudiante que está conectado y esperando que el docente lo apruebe, mostrando el radar animado y asistencia para celulares.
  * **Vista 2 (Autorizada)**: Muestra el cronómetro de tiempo restante en cuenta regresiva, aviso sonoro de advertencia cuando quedan menos de 3 minutos, tarjeta de velocidad asignada, recursos compartidos disponibles y botón de activación de notificaciones.
  * **Vista 3 (Expirada)**: Informa el fin del tiempo de conexión y ofrece el botón para solicitar una nueva sesión.
  * **Banner de Comunicados**: Notificación en la parte superior con sonido sintetizado, botón de cerrar y botón persistente `✓ Marcar como leído`.
  * **Modal Visor de Archivos**: Modal embebido con contenedor para PDF.js, previsualizador de código e imágenes.

### `frontend/portal.js`
* **Responsabilidad**: Lógica del portal del alumno.
* **Aspectos técnicos**:
  * Consulta constante a `/portal/status` para transicionar automáticamente de la sala de espera al escritorio autorizado en cuanto el docente hace clic en "Aprobar".
  * Cuenta regresiva precisa en JavaScript calculada a partir del tiempo restante devuelto por el servidor.
  * **Generador de Audio Nativo (`reproducirSonidoPortal`)**: Genera sonidos de alerta y campanas mediante la **Web Audio API** sintetizando osciladores de onda senoidal, eliminando la necesidad de archivos `.mp3` externos.
  * **Despachador Universal de Notificaciones (`dispararNotificacionSistema`)**: Detecta si el navegador soporta Service Workers para emitir notificaciones nativas en segundo plano (Android / PC) con vibración (`navigator.vibrate`).
  * Manejo de lectura persistente en `localStorage` sincronizado con `/messages/{id}/read`.
  * Integración con `pdf.min.js` para renderizar documentos página por página mediante HTML5 Canvas.

### `frontend/style.css`
* **Responsabilidad**: Hoja de estilos central y sistema de diseño unificado.
* **Características**:
  * **Modo Oscuro (por defecto)**: Estilo futurista con paleta oscura, bordes brillantes de cian (`#00F0FF`) y violeta (`#8B5CF6`), efectos de desenfoque de fondo (*glassmorphism*) y radar de pulso en CSS puro.
  * **Modo Claro (Alta Legibilidad)**: Selector `[data-theme="light"]` que reasigna todas las variables CSS para ofrecer tarjetas con fondos blancos nítidos, sombras suaves y tipografía oscura (`#0F172A`) con contraste accesible WCAG AAA.
  * Diseño totalmente responsivo adaptado a computadoras de escritorio, tablets y pantallas de celulares.

### `frontend/sw.js`
* **Responsabilidad**: Service Worker para la Progressive Web App (PWA) y notificaciones de sistema.
* **Comportamiento**: Se activa en el navegador del alumno y atiende el evento `notificationclick`. Cuando el alumno pulsa una notificación en la barra de tareas de Android o Windows, el Service Worker localiza la pestaña de `portal.html` y la enfoca de inmediato.

### `frontend/chart.js`, `pdf.min.js`, `pdf.worker.min.js`
* **Responsabilidad**: Librerías de cliente empaquetadas localmente para permitir el funcionamiento del laboratorio 100% desconectado de internet exterior (offline-first).

---

## 5. Librerías y Recursos Utilizados (¿Por qué se eligieron?)

### Tecnologías y Librerías del Backend

| Librería / Recurso | Versión | ¿Por qué se utilizó? |
| :--- | :--- | :--- |
| **FastAPI** | `0.115.0` | Framework web moderno para Python. Se eligió por su altísima velocidad (basado en Starlette y ASGI), generación automática de documentación interactiva OpenAPI/Swagger (`/docs`), validación estricta de tipos de datos mediante Pydantic y soporte nativo de asincronía. |
| **Uvicorn** | `0.30.6` | Servidor web ASGI de producción ultraliviano y de alto rendimiento que ejecuta la aplicación FastAPI. |
| **SQLAlchemy** | `2.0.35` | ORM (Object-Relational Mapping) estándar de la industria en Python. Permite modelar las tablas como clases orientadas a objetos, ejecutar consultas seguras contra inyecciones SQL y desacoplar la lógica del motor de base de datos. |
| **psycopg2-binary** | `2.9.9` | Driver de conexión nativo en C entre Python y PostgreSQL, altamente maduro, confiable y rápido. |
| **librouteros** | `3.4.1` | Librería especializada en comunicación binaria con el protocolo API nativo de MikroTik RouterOS (puerto 8728). Se eligió porque es infinitamente más rápida, segura y estructurada que intentar enviar comandos por SSH o Telnet. |
| **python-dotenv** y **pydantic-settings** | `1.0.1` / `2.5.2` | Permiten cargar de forma segura las variables del archivo `.env`, validando que cada configuración tenga el tipo de dato correcto antes de que el servidor arranque. |
| **pyjwt** | `2.9.0` | Generación y validación de tokens JSON Web Tokens (JWT). Permite mantener sesiones sin estado (stateless) para el docente, evitando sobrecargar la memoria del servidor. |
| **passlib** y **bcrypt** | `1.7.4` / `4.0.1` | Implementan hashing unidireccional de contraseñas con salado criptográfico (*salting*), garantizando que las credenciales del docente nunca se guarden en texto plano. |

### Tecnologías y Librerías del Frontend

| Librería / Recurso | Tipo | ¿Por qué se utilizó? |
| :--- | :--- | :--- |
| **Vanilla HTML5 & CSS3** | Nativo | Se evitó intencionalmente el uso de frameworks pesados como React, Angular o Tailwind compilado. Esto garantiza que el frontend sea extremadamente liviano, cargue instantáneamente y no requiera un proceso de compilación `npm build` en el aula. |
| **Chart.js** | Empaquetado local | Librería de gráficos interactivos basada en HTML5 Canvas. Se eligió por su fluidez en renderizado de series de tiempo y gráficos de barra para representar el consumo de red y actividad. Está guardada localmente para no depender de internet exterior. |
| **PDF.js (Mozilla)** | Empaquetado local | Motor de renderizado de documentos PDF desarrollado por Mozilla. Permite que los alumnos lean las guías prácticas y manuales del laboratorio directamente en una ventana modal dentro del navegador, sin obligarlos a descargar aplicaciones de terceros (Adobe Reader, etc.). |
| **Service Worker API** | Estándar W3C | Permite que las notificaciones del sistema funcionen en teléfonos móviles Android y en ordenadores aunque el usuario esté usando otra pestaña o aplicación. |
| **Web Audio API** | Nativo del navegador | En lugar de cargar archivos pesados `.mp3` que consumen ancho de banda o pueden fallar por códecs del sistema operativo, el frontend genera tonos armónicos en tiempo real usando osciladores matemáticos nativos del chip de audio. |

---

## 6. Flujos Lógicos Integrados de la Plataforma

```
 +--------------------------------------------------------------------------+
 |                      FLUJO 1: CONEXIÓN DE UN ALUMNO                      |
 +--------------------------------------------------------------------------+
 1. Alumno conecta su cable de red o WiFi al MikroTik.
 2. MikroTik le entrega una IP mediante DHCP.
 3. El backend detecta la nueva IP y MAC en los leases del router.
 4. Convierte la concesión en ESTÁTICA ÚNICA para que esa IP no se repita.
 5. Agrega la IP a la address-list "blocked-devices" (sin salida a internet).
 6. El alumno abre el navegador y entra a "portal.html": ve la SALA DE ESPERA.

 +--------------------------------------------------------------------------+
 |                      FLUJO 2: APROBACIÓN POR EL DOCENTE                  |
 +--------------------------------------------------------------------------+
 1. El docente ve la solicitud en la pestaña "Dispositivos" del panel.
 2. Selecciona el rol (ej. Nivel 1) y pulsa "Aprobar".
 3. Backend retira la IP de "blocked-devices" en el router (habilita internet).
 4. Backend crea una cola Simple Queue (ej. límite 10 Mbps) en el router.
 5. Backend inicia la Sesión con el tiempo configurado para ese rol.
 6. En menos de 3s, el portal del alumno pasa automáticamente a VISTA ACTIVA.

 +--------------------------------------------------------------------------+
 |                      FLUJO 3: CONTROL DE TIEMPO Y ACTIVIDAD              |
 +--------------------------------------------------------------------------+
 1. Mientras navega, el router cuenta bytes de subida y bajada.
 2. Si hay tráfico significativo, la sesión acumula "tiempo activo".
 3. Si no hay transferencia, el sistema registra "tiempo muerto / inactividad".
 4. Al llegar a los últimos 3 minutos, el portal emite un aviso sonoro y visual.
 5. Al expirar el tiempo, el backend bloquea nuevamente la IP en el firewall
    y el alumno ve la pantalla de sesión finalizada.

 +--------------------------------------------------------------------------+
 |                      FLUJO 4: COMUNICADOS Y PUSH NOTIFICATIONS           |
 +--------------------------------------------------------------------------+
 1. El docente escribe un aviso urgente o comparte una guía de laboratorio.
 2. El backend lo publica y registra a todos los alumnos conectados.
 3. Los dispositivos de los alumnos reciben el evento en segundo plano.
 4. El Service Worker dispara la notificación nativa en la barra de Android/PC
    junto con vibración física y sonido sintetizado.
 5. El alumno pulsa "✓ Marcar como leído": el banner se oculta permanentemente
    y el panel del docente actualiza el contador en tiempo real (ej. 15 / 15).
```
