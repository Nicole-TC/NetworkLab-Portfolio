# Configuración del Hotspot en el MikroTik (RB750Gr3 hEX)

Esta guía documenta cómo configurar la función **Hotspot** nativa de
RouterOS para cubrir, usando el propio router, tres de las
funcionalidades del proyecto: login/registro de dispositivos,
aprobación manual de dispositivos nuevos, y límite de tiempo de
conexión.

Se hace en dos etapas: primero el Hotspot básico (login funcionando),
después el mecanismo de aprobación manual por dispositivo.

> Nota de hardware: el RB750Gr3 (hEX) no tiene WiFi. El Hotspot
> funciona igual para conexiones por cable — cuando un dispositivo
> nuevo intenta navegar, se lo redirige a la página de login
> automáticamente, sea WiFi o Ethernet.

---

## Conceptos clave

- **Hotspot**: función de RouterOS que intercepta la navegación de un
  dispositivo nuevo y le muestra una página de login antes de dejarlo
  salir a internet (portal cautivo).
- **Address pool**: rango de IPs que el Hotspot les asigna a los
  dispositivos que se conectan a su interfaz.
- **User profile**: plantilla que define, para un grupo de usuarios,
  el límite de tiempo de sesión (`session-timeout`) y el límite de
  velocidad (`rate-limit`).
- **IP Binding**: lista donde queda registrado cada dispositivo
  (por MAC) que intentó conectarse. Es el mecanismo que usamos para
  la aprobación manual: por defecto, todo dispositivo nuevo queda
  bloqueado, y el admin lo "aprueba" agregándolo a esta lista con tipo
  `regular`.

---

## Etapa 1 — Hotspot básico

1. En Winbox, abrir **IP → Hotspot → Hotspot Setup** (el asistente
   guiado, más simple que configurarlo a mano la primera vez).

2. **Hotspot Interface**: elegir la interfaz (o el bridge de las
   interfaces LAN) por donde se van a conectar los dispositivos —
   por ejemplo, el bridge que agrupa ether2 a ether5, dejando ether1
   como WAN (conexión a internet / al router existente del instituto).

3. **Local Address of Network**: la IP del router en esa red interna
   (por ejemplo `192.168.10.1/24`). Esta va a ser la puerta de enlace
   de los dispositivos conectados.

4. **Address Pool of Network**: el rango de IPs a repartir, por
   ejemplo `192.168.10.10-192.168.10.254`.

5. **Select Certificate**: dejar en `none` por ahora (los certificados
   son para HTTPS en la página de login, se puede sumar después).

6. **IP Address of SMTP Server**: dejar en `0.0.0.0` (no se usa acá).

7. **DNS Servers**: se puede dejar el DNS del router mismo, o poner
   `8.8.8.8` como respaldo.

8. **DNS Name**: un nombre amigable para la página de login, por
   ejemplo `networklab.local` (no hace falta que sea un dominio real,
   es solo para mostrar una URL linda en vez de una IP).

9. **Name of Local Hotspot User** / **Password**: esto crea un primer
   usuario de prueba. Se puede usar para las primeras pruebas, después
   se define bien el manejo de usuarios.

10. Finalizar el asistente. RouterOS crea automáticamente: el
    Hotspot server, el pool de IPs, el DHCP server para esa red, y un
    profile de usuario por defecto.

**Prueba**: conectar una notebook o celular (por cable, ya que este
router no tiene WiFi) a uno de los puertos incluidos en el bridge del
Hotspot. Al intentar abrir cualquier página web, debería aparecer la
pantalla de login de RouterOS. Ingresando el usuario de prueba creado
en el paso 9, debería dar acceso a internet.

---

## Etapa 2 — Aprobación manual de dispositivos nuevos

Con el Hotspot básico funcionando, el siguiente paso es que **un
dispositivo nuevo no pueda entrar solo con user/password genérico**,
sino que necesite aprobación del admin.

1. Ir a **IP → Hotspot → IP Bindings**.

2. Por defecto esta lista está vacía. Cuando alguien nuevo se conecta
   al Hotspot, va a aparecer en **IP → Hotspot → Hosts** (ahí se ve su
   MAC, IP, y si está autenticado o no).

3. Para que un dispositivo necesite aprobación explícita (no alcance
   con que alguien sepa el usuario y contraseña genérico), la lógica
   que vamos a usar es:
   - Dejar el Hotspot en modo login normal (usuario/contraseña) para
     el primer contacto.
   - Cuando el admin ve un host nuevo en **Hosts**, y quiere
     aprobarlo de forma permanente (para que no tenga que loguearse
     cada vez), lo agrega en **IP Bindings** con:
     - **MAC Address**: la del dispositivo.
     - **Type**: `bypassed` (deja pasar sin pedir login de nuevo) o
       `regular` (sigue pidiendo login, pero queda "reconocido").
   - Si el admin quiere bloquear a alguien específico sin importar
     que tenga el usuario/contraseña, lo agrega con **Type**:
     `blocked`.

4. Esto se puede integrar con el backend del proyecto (Nivel 1) más
   adelante: el backend puede leer la lista de **Hosts** vía la API de
   RouterOS, mostrarla en el panel de administración con un botón de
   "Aprobar/Rechazar", y aplicar el cambio correspondiente en **IP
   Bindings** automáticamente — así el admin no necesita entrar a
   Winbox para aprobar cada dispositivo.

---

## Etapa 3 — Límite de tiempo y ancho de banda por perfil

1. Ir a **IP → Hotspot → User Profiles**.

2. Crear (o editar el default) un profile, por ejemplo `estudiantes`:
   - **Session Timeout**: tiempo máximo de una sesión, por ejemplo
     `01:00:00` (1 hora). Al llegar a ese tiempo, se corta la sesión
     y el dispositivo tiene que volver a loguearse.
   - **Rate Limit (rx/tx)**: límite de velocidad, por ejemplo
     `2M/2M` (2 Mbps de subida y bajada).

3. Asignar ese profile a los usuarios (**IP → Hotspot → Users**) o
   dejarlo como el profile por defecto de todos los que entren por el
   Hotspot.

---

## Pendiente / próximos pasos

- Definir si se usa un usuario Hotspot genérico para todos, o un
  usuario por persona (más prolijo para las estadísticas, pero
  requiere gestionar más cuentas).
- Integrar la aprobación de **IP Bindings** con el backend (Nivel 1
  del proyecto), para no depender de entrar a Winbox manualmente.
- Evaluar RADIUS / User Manager si se necesita un manejo de usuarios
  más grande a futuro (fuera del alcance inicial del proyecto).
