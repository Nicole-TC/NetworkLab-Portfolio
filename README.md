# Laboratorio2-Tacuri
## Router Mikrotik modelo hEX (RB750Gr3)
# NetworkLab — Plataforma de administración de red y laboratorios

Panel de administración que permite gestionar la red de un laboratorio,
aula o pequeña oficina a través de un router **MikroTik hEX (RB750Gr3)**
(RouterOS API): registro y aprobación de dispositivos, control de ancho
de banda, sesiones, filtrado de sitios web, mensajería y archivos.

Este documento es la referencia central del proyecto: por qué existe,
cómo está organizado en niveles de prioridad, qué hace cada módulo, y
cómo desplegarlo. Se va actualizando a medida que avanza el desarrollo.

---

## 1. Contexto y objetivo

El proyecto nace como trabajo de laboratorio para una materia de practicas profesionalizante para la tecnicatura de analista de sistema, y el proyecto se trata y tiene que ver con redes,
con estos requisitos obligatorios del profesor:

1. **Despliegue unificado**: todo el proyecto debe levantar con un solo
   comando, `docker-compose up --build`. No se permite instalar
   dependencias manualmente en el sistema operativo host.
2. **Seguridad de credenciales**: ningún token, contraseña o credencial
   se sube al repositorio. Todo secreto vive en un archivo `.env`
   basado en un `.env.example` versionado.
3. **Buenas prácticas de Git**: uso de ramas por funcionalidad
   (`feature/...`), mensajes de commit descriptivos, y documentación
   clara del proceso de despliegue (este README).

La idea del software es genérica: el mismo "núcleo" (backend + base de
datos + integración con MikroTik) sirve tanto para un aula de un
instituto como para una oficina chica o un centro de capacitación. Lo
que cambia entre esos escenarios es la infraestructura de red física,
no el software.

### Escenarios de prueba previstos

1. **Casa** (primeras pruebas): dos notebooks y una PC y cuento con un router de movistar que es el que da internet a la casa,
   todo conectado directo al MikroTik.
2. **Aula de computación del instituto** (prueba previa a la
   exposición): el MikroTik se conecta a un gabinete rack existente en el switch que cuenta este rack ahi es donde se conectan todos los equipos, tambien tienen un router.
   **Importante**: antes de esta prueba hay que confirmar con quien
   administra esa red si el MikroTik debe actuar solo como switch/AP
   (sin repartir DHCP propio) o si va a tener un segmento de red
   aislado — conectar un segundo servidor DHCP a una red que ya tiene
   uno puede cortar la conectividad de toda el aula.
3. **Día de la exposición**: demostración en vivo con las
   computadoras del aula.

---

## 2. Hardware de red

El laboratorio usa un **MikroTik hEX (RB750Gr3)**: 5 puertos Gigabit
Ethernet, CPU dual-core 880MHz, 256MB RAM, puerto USB y microSD. A
diferencia del equipo usado en las primeras pruebas (RB951Ui-2HnD),
**este modelo no tiene WiFi** — es "wired only". Esto significa que la
conectividad inalámbrica para celulares depende de un Access Point
externo o del WiFi ya existente en el lugar donde se despliegue (ver
sección de escenarios de prueba), pero se puede descartar la conexion con los celulares era adicional.

### Aprovechar RouterOS al máximo (enfoque híbrido)

Por indicación del profesor, el proyecto no reimplementa en el backend
funciones que RouterOS ya resuelve nativamente. El diseño es híbrido:

- **RouterOS hace lo que sabe hacer nativamente**: Hotspot (login,
  aprobación de dispositivos, límite de tiempo), Queue Trees/Simple
  Queues (ancho de banda), VLAN (segmentación de red), DHCP, backups
  de configuración.
- **El backend (este repositorio) se enfoca en lo que RouterOS no
  trae**: dashboard centralizado, estadísticas e historial más ricos,
  archivos compartidos, mensajería con confirmación, y el bot de
  alertas — y opcionalmente orquesta al Hotspot vía la API de RouterOS
  (por ejemplo, leyendo la lista de hosts pendientes y aplicando la
  aprobación sin tener que entrar a Winbox).

La configuración paso a paso del Hotspot está documentada en
[`docs/hotspot-setup.md`](docs/hotspot-setup.md).

## 3. Arquitectura

```
 ADMINISTRADOR
     │
     ▼
 NETWORKLAB (backend + panel)
     │
     ┌────────────────┼────────────────┐
     │                │                │
     ▼                ▼                ▼
 DISPOSITIVOS         RED            USUARIOS
     │                │                │
 ├─ Autorizar     ├─ DHCP          ├─ Mensajes
 ├─ Bloquear      ├─ Firewall      ├─ Archivos
 ├─ Sesiones      ├─ QoS           └─ Permisos
 ├─ Tiempo        ├─ DNS
 └─ Consumo       └─ VLAN (futuro)
                      │
                      ▼
                  MikroTik
              ┌───────┼───────┐
              ▼       ▼       ▼
             PC      PC   Celular
```

- **Backend (FastAPI, Python)**: expone una API REST, habla con el
  router por la API nativa de RouterOS (librería `librouteros`), y
  guarda todo el estado (dispositivos, sesiones, logs) en Postgres.
- **Base de datos (Postgres)**: única fuente de verdad histórica. El
  MikroTik **no se usa como almacenamiento** — solo aplica las
  políticas de red que el backend le indica (bloquear una IP, crear
  una cola de ancho de banda, etc.).
- **MikroTik**: hace lo mínimo posible, acorde a su hardware limitado
  (procesador de 600MHz, 128MB RAM, WiFi solo 2.4GHz): DHCP, reglas de
  firewall simples (address-lists), colas de ancho de banda, DNS
  estático para el filtrado de dominios. Nada de procesamiento pesado
  ahí.

### Nota sobre filtrado de sitios web y HTTPS

Casi todo el tráfico de internet hoy va cifrado (HTTPS). Con HTTPS:

- **Sí se puede saber** a qué *dominio* se conectó un dispositivo
  (ej. `youtube.com`), vía el nombre que pide por DNS o el campo SNI
  de la conexión.
- **No se puede leer** el contenido de las páginas ni las páginas
  específicas dentro de un dominio — eso requeriría interceptar el
  tráfico con certificados propios (DPI), algo invasivo y fuera del
  alcance de este proyecto.

Por eso, el filtrado de dominios se implementa vía **DNS estático** en
el MikroTik: si un dispositivo pide resolver un dominio bloqueado, el
router responde con una dirección inválida. Es liviano, no exige nada
al hardware del router, y es honesto sobre lo que puede y no puede
controlar.

---

## 4. Estado actual

- [x] Esqueleto Docker (backend FastAPI + Postgres + Adminer)
- [x] Registro de dispositivos vía DHCP leases
- [x] Autorización / bloqueo de dispositivos (address-list de firewall)
- [x] Sesiones (inicio, fin, duración por dispositivo)
- [x] Tiempo total conectado por dispositivo
- [x] Guía de configuración de Hotspot documentada (`docs/hotspot-setup.md`)
- [ ] Hotspot configurado y probado en el router físico (pendiente de recibir el hEX)
- [ ] Inactividad (tráfico vs. actividad real, requiere diseño adicional)
- [ ] Control de ancho de banda (QoS)
- [ ] Límite temporal de conexión
- [ ] Filtrado de dominios + alertas
- [x] Dashboard básico (frontend web: lista de dispositivos, aprobar/rechazar, sesiones activas)
- [ ] Archivos (subida/descarga)
- [ ] Mensajería con confirmación de entrega
- [ ] Portal del usuario
- [ ] Usuarios y roles (admin / profesor / estudiante)
- [ ] Estadísticas
- [ ] Bot de Telegram (alertas externas)

---

## 5. Niveles de prioridad

El proyecto tiene muchas funcionalidades posibles. Para que sea
manejable en el tiempo disponible, se dividió en niveles: no se pasa
al siguiente nivel hasta que el anterior esté sólido.

### 🔴 Nivel 1 — Obligatorio (base del sistema)

Sin esto, no hay proyecto.

- Docker, backend, base de datos, integración básica con MikroTik.
- **Registro de dispositivos**: IP, MAC, nombre de host (si está
  disponible), primera detección, última detección, estado.
- **Autorización y bloqueo**: el administrador decide si un
  dispositivo puede usar la red; el backend aplica la política en el
  MikroTik (address-list + regla de firewall) y registra la acción.
- **Sesiones**: registrar inicio, fin y duración de cada conexión.
  Permitir consultar historial por dispositivo y por período.
- **Tiempo conectado**: separar tiempo total conectado de períodos
  sin tráfico significativo. *Aclaración importante*: esto mide
  tráfico de red, no equivale a saber si una persona dejó de tocar el
  teclado o el mouse — son conceptos distintos y no se debe prometer
  lo segundo.

### 🟠 Nivel 2 — Funcionalidades de red

- **Ancho de banda (QoS)**: límites de velocidad por dispositivo o por
  grupo, vía simple queues de RouterOS. Velocidad en Mbps, volumen
  transferido en MB/GB.
- **Límite temporal**: hora de inicio, duración y finalización de una
  sesión permitida; aviso antes de que termine; política de
  restricción automática al finalizar.
- **Dominios restringidos**: listas de dominios permitidos/bloqueados
  vía DNS estático (ver nota de HTTPS arriba); registro de intentos
  identificables.
- **Alertas**: nuevo dispositivo pidiendo conexión, bloqueos, intentos
  de acceso a dominios no permitidos, fin de tiempo de conexión,
  problemas de comunicación con el MikroTik.

### 🟢 Nivel 3 — Plataforma

- **Archivos**: el admin/profesor sube PDF, ZIP u otros materiales al
  servidor; los usuarios autorizados los descargan desde el portal. El
  MikroTik no se usa como almacenamiento.
- **Mensajería**: enviar mensajes a todos, a un grupo, o a un
  dispositivo/usuario específico; registrar enviado, entregado y
  confirmado.
- **Portal del usuario**: página simple donde cada usuario ve sus
  mensajes, confirma recepción, descarga archivos y ve su tiempo
  restante de conexión.
- **Usuarios y roles**: administrador, profesor/operador y
  usuario/estudiante, con permisos diferenciados. Las contraseñas se
  guardan siempre con hash, nunca en texto plano.

### 🔵 Nivel 4 — Extra (si alcanza el tiempo)

- **Bot de Telegram**: alertas externas al administrador (nuevo
  dispositivo, bloqueo, intento no permitido, fin de tiempo). Se
  implementa recién después de tener sólidos los niveles anteriores.
- **Estadísticas avanzadas**: tiempo de uso, conexiones, tráfico
  histórico, eventos bloqueados, gráficos.
- **Ideas que requieren diseño adicional, para más adelante**: VLAN e
  inter-VLAN routing (separar redes de alumnos y profesores a nivel
  de red), estadísticas de tráfico detalladas, detección más fina de
  inactividad.

---

## 6. Glosario rápido de redes

Para quien no viene del mundo de redes:

- **DHCP**: servicio que asigna automáticamente una IP a cada
  dispositivo que se conecta.
- **QoS (Quality of Service)**: reglas para priorizar o limitar
  tráfico — permite decir "este dispositivo no puede pasar de 5 Mbps".
- **VLAN**: forma de dividir una red física en redes "virtuales"
  separadas (por ejemplo, que los celulares de alumnos no vean
  directamente la PC del profesor, aunque compartan el mismo switch).
- **DNS**: servicio que traduce nombres (`ejemplo.com`) a direcciones
  IP. Es la base del filtrado de dominios de este proyecto.
- **Address-list / firewall rule**: en RouterOS, una lista de
  direcciones IP a la que se le puede aplicar una acción (por ejemplo,
  bloquear todo el tráfico de las IPs de esa lista).
- **Hotspot**: función nativa de MikroTik que muestra una página de
  login antes de dar acceso a internet — candidata a usar como base
  del portal del usuario (Nivel 3) en vez de construir el login desde
  cero.

---

## 7. Requisitos previos

- Docker y Docker Compose instalados.
- Un router MikroTik con la API de RouterOS habilitada (ver sección 8).
- **No se necesita instalar Python, Postgres, ni ninguna dependencia en
  el sistema host.** Todo corre dentro de los contenedores.

## 8. Cómo levantar el proyecto

1. Copiar el archivo de ejemplo de variables de entorno:

   ```bash
   cp .env.example .env
   ```

2. Completar `.env` con los datos reales del router y las credenciales
   que quieras usar (nunca subir este archivo al repositorio, ya está
   en `.gitignore`).

3. Levantar todo con un solo comando:

   ```bash
   docker-compose up --build
   ```

4. Servicios disponibles:
   - **Panel de administración (frontend)**: http://localhost:3000
   - Backend (FastAPI): http://localhost:8000
   - Documentación interactiva de la API: http://localhost:8000/docs
   - Adminer (ver la base de datos): http://localhost:8080
     (sistema: PostgreSQL, servidor: `db`, usuario/clave/base: los del
     `.env`)

## 9. Preparar el router (una sola vez, manual)

1. En Winbox: `IP → Services` y confirmar que el servicio `api` está
   habilitado (puerto 8728).
2. En `System → Users`, crear un usuario dedicado (por ejemplo
   `api-lab`) con permisos suficientes para leer DHCP y editar
   firewall.
3. Crear la address-list de bloqueo y la regla de firewall que la usa
   (el backend no la crea automáticamente, se hace una sola vez):

   En `IP → Firewall → Filter Rules`, agregar una regla:
   - Chain: `forward`
   - Src. Address List: `blocked-devices`
   - Action: `drop`

   Con esto, cualquier dispositivo que el panel marque como
   "pendiente" o "rechazado" queda sin salida a internet hasta que el
   admin lo apruebe.

### ⚠️ Nota sobre la alimentación del equipo

El router usado en este proyecto (RB951Ui-2HnD) requiere una fuente de
**24V**. Alimentarlo con una fuente de voltaje distinto (por ejemplo,
una fuente genérica de 12V pensada para cámaras/audio) puede causar
reinicios intermitentes bajo carga, o directamente dañar el equipo.
Verificar siempre la etiqueta de la fuente antes de conectar.

## 10. Uso básico de la API (mientras no hay frontend)

- `POST /devices/sync` → lee los leases DHCP del router y registra
  como "pending" los dispositivos nuevos (y los bloquea
  automáticamente).
- `GET /devices/` → lista todos los dispositivos registrados.
- `GET /devices/?status=pending` → solo los pendientes de aprobación.
- `POST /devices/{id}/approve` → aprueba y desbloquea el dispositivo.
- `POST /devices/{id}/reject` → rechaza y lo mantiene/pasa a
  bloqueado.
- `POST /sessions/sync` → abre sesiones nuevas para dispositivos
  aprobados que aparecen en los leases DHCP, y cierra las sesiones de
  los que dejaron de aparecer por más de 5 minutos.
- `GET /sessions/` → historial completo de sesiones (opcionalmente
  `?device_id=` para filtrar por dispositivo).
- `GET /sessions/active` → dispositivos conectados en este momento.
- `GET /sessions/device/{id}/total-time` → tiempo total conectado de
  un dispositivo, sumando todas sus sesiones.

> **Nota**: en esta etapa, `POST /devices/sync` y `POST /sessions/sync`
> se llaman manualmente (por ejemplo, desde `/docs`). Más adelante se
> puede automatizar con una tarea periódica (cada 1-2 minutos) para
> que el registro sea continuo sin intervención manual.

## 11. Flujo de trabajo con Git

- La rama `main` siempre debe quedar en un estado que levante con
  `docker-compose up --build` sin errores.
- Cada funcionalidad nueva se desarrolla en su propia rama, con el
  patrón:

  ```
  feature/<nombre-corto>
  ```

  Ejemplos: `feature/sessions`, `feature/qos-bandwidth`,
  `feature/web-filtering`, `feature/telegram-bot`.

- Los mensajes de commit deben ser descriptivos, en modo imperativo:

  ```
  git commit -m "Agregar registro de sesiones por dispositivo"
  ```

- Antes de mergear a `main`, actualizar la sección "Estado actual" de
  este README marcando el módulo como completado.

## 12. Seguridad de credenciales

- Ningún token, contraseña o credencial va en el código ni se sube al
  repositorio.
- Todo secreto vive en `.env` (ignorado por git) y se referencia desde
  el código vía variables de entorno (ver `app/config.py`).
- `.env.example` documenta qué variables existen, sin valores reales.
- Las contraseñas de usuarios del sistema (cuando se implemente el
  módulo de roles) se guardan siempre con hash, nunca en texto plano.
