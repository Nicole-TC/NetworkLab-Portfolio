# 🛡️ NetworkLab — Plataforma de Administración de Red y Laboratorios
### Router MikroTik hEX (RB750Gr3) | Prácticas Profesionalizantes — Analista de Sistemas

![NetworkLab Architecture](https://img.shields.io/badge/RouterOS-v7.x%20API-blue?logo=mikrotik)
![FastAPI](https://img.shields.io/badge/Backend-FastAPI%20%7C%20Python%203.11-009688?logo=fastapi)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL%2016-336791?logo=postgresql)
![Docker Compose](https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED?logo=docker)
![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20%7C%20PWA%20%7C%20Chart.js-yellow)

Panel centralizado de administración de red y gestión pedagógica de estaciones de trabajo para aulas de informática, laboratorios o pequeñas instituciones educativas. La plataforma interactúa en tiempo real con un router **MikroTik hEX (RB750Gr3)** mediante la API binaria de RouterOS, integrando autorización de dispositivos, control de ancho de banda (QoS), portal cautivo, filtrado web por lista blanca, distribución de materiales didácticos, medición de tiempos de conexión y comunicados con acuse de recibo.

---

## 📑 Tabla de Contenidos

1. [Contexto y Objetivos del Proyecto](#1-contexto-y-objetivos-del-proyecto)
2. [Arquitectura del Sistema (Enfoque Híbrido)](#2-arquitectura-del-sistema-enfoque-híbrido)
3. [Hardware de Red Utilizado](#3-hardware-de-red-utilizado)
4. [Funcionalidades Principales Implementadas](#4-funcionalidades-principales-implementadas)
5. [Requisitos Previos y Despliegue Rápido](#5-requisitos-previos-y-despliegue-rápido)
6. [Configuración Inicial del Router MikroTik](#6-configuración-inicial-del-router-mikrotik)
7. [Endpoints Clave de la API](#7-endpoints-clave-de-la-api)
8. [Auditoría del Proyecto: ¿Nos falta algo?](#8-auditoría-del-proyecto-nos-falta-algo)
9. [Estructura Detallada de Archivos](#9-estructura-detallada-de-archivos)

---

## 1. Contexto y Objetivos del Proyecto

El proyecto surge como trabajo integrador para la materia de **Prácticas Profesionalizantes** de la carrera **Tecnicatura Superior en Analista de Sistemas**. 

El objetivo es resolver una problemática cotidiana en las salas de computación de instituciones educativas: **la falta de control sobre los equipos conectados, la dispersión de los alumnos en sitios no académicos, la saturación del ancho de banda y la dificultad para distribuir guías de trabajo y comunicarse con los estudiantes en tiempo real**.

### Requisitos Obligatorios Cumplidos:
* **Despliegue Unificado con Docker**: El sistema completo se inicia con un único comando (`docker-compose up --build`), sin instalar dependencias manuales en el sistema host.
* **Seguridad de Credenciales**: Ninguna clave, contraseña o token está hardcodeada. Todo se gestiona mediante `.env` basado en una plantilla versionada `.env.example`.
* **Persistencia y Fuente de Verdad**: La base de datos PostgreSQL actúa como repositorio central histórico. El router MikroTik no se sobrecarga con almacenamiento, únicamente ejecuta las reglas que el backend le instruye.

---

## 2. Arquitectura del Sistema (Enfoque Híbrido)

El diseño del proyecto sigue un **enfoque híbrido**: RouterOS se encarga de lo que resuelve nativamente a nivel hardware y kernel (firewall, colas QoS, asignaciones DHCP, DNS), mientras que el backend y frontend proporcionan la inteligencia de negocio, analítica, almacenamiento y experiencia de usuario.

```
       +-------------------------------------------------------------+
       |               DOCENTE / ADMINISTRADOR DE RED                |
       +-------------------------------------------------------------+
                                      │
                                      ▼
                        Panel Web (Nginx - Puerto 3000)
                     [index.html / app.js / Chart.js]
                                      │
                                      ▼
                   Backend REST API (FastAPI - Puerto 8000)
                     [main.py / routeros_client.py / ORM]
                                 │         │
                 ┌───────────────┘         └────────────────┐
                 ▼                                          ▼
     Base de Datos PostgreSQL (5432)            Router MikroTik hEX (8728)
       [Dispositivos, Sesiones,                   [DHCP Leases, Address-Lists,
     Archivos, Mensajes, Dominios]                 Simple Queues, Static DNS]
                                                            │
                                              ┌─────────────┴─────────────┐
                                              ▼                           ▼
                                      Estación Alumno (PC)         Celular / Tablet
                                     [portal.html / PWA]         [Captive Portal / PWA]
```

* **Backend (FastAPI, Python 3.11)**: API REST asíncrona de alto rendimiento conectada al router vía `librouteros` por el puerto 8728.
* **Base de Datos (PostgreSQL 16 Alpine)**: Almacena el registro de equipos, sesiones históricas, consumo de tráfico, confirmaciones de lectura y políticas por rol.
* **Frontend (Nginx Alpine)**: SPA desarrollada en Vanilla JavaScript, CSS modular, Chart.js y PDF.js. No requiere pasos de compilación `npm build`.
* **Router MikroTik**: Conmutación a velocidad de cable, aislamiento de tráfico no autorizado en la lista de firewall `blocked-devices`, colas simples de ancho de banda y resolución de DNS local.

---

## 3. Hardware de Red Utilizado

El proyecto utiliza un **MikroTik hEX (RB750Gr3)**:
* **Procesador**: MediaTek MT7621A dual-core a 880 MHz (4 hilos de ejecución).
* **Memoria RAM**: 256 MB.
* **Puertos**: 5 interfaces Gigabit Ethernet (10/100/1000 Mbps).
* **Almacenamiento Adicional**: Puerto USB y ranura microSD.
* **Alimentación**: Fuente de 24V.
* **Conectividad Inalámbrica**: Este modelo es *wired-only* (sin radio WiFi integrada). En caso de conectar teléfonos celulares o tablets, se conecta un Access Point externo o el switch del aula a una de las bocas LAN del router.

---

## 4. Funcionalidades Principales Implementadas

### 1. Detección y Reserva de IP Estática Única
* Cuando un equipo se conecta a la red, el servidor DHCP de MikroTik le asigna una IP dinámica.
* El backend detecta la concesión y la convierte automáticamente en una **reserva estática vinculada a la dirección MAC del equipo**. Esto garantiza que cada dispositivo conserve siempre la misma dirección IP exclusiva como su identificador de red, evitando colisiones o reasignaciones a otros equipos.

### 2. Sala de Espera y Portal Cautivo para Alumnos (`portal.html`)
* Los equipos no aprobados quedan aislados automáticamente de internet en la lista `blocked-devices`.
* Al abrir el navegador, el estudiante accede a una **Sala de Espera** con animación de radar de sincronización y detección automática de su equipo e IP.
* En cuanto el docente autoriza al alumno desde el panel, el portal pasa en tiempo real (sin refrescar la página) a la **Vista Autorizada**, iniciando el temporizador de sesión.

### 3. Control de Tiempo de Conexión y Detección de Inactividad
* Cada rol tiene asignado un límite de tiempo de conexión (ej. 120 minutos).
* El portal del alumno descuenta el tiempo en pantalla con un reloj de alta visibilidad y dispara alertas visuales y sonoras cuando restan menos de 3 minutos.
* Al expirar el tiempo, el router corta el acceso y la interfaz le ofrece al alumno un botón para solicitar una nueva sesión.
* El sistema audita el tráfico transmitido para diferenciar el **tiempo activo** del **tiempo muerto / inactividad** del equipo.

### 4. Control de Ancho de Banda (QoS)
* Al aprobar a un estudiante, el backend crea dinámicamente una cola simple (`/queue/simple`) en RouterOS asociada a su IP.
* Aplica límites simétricos o asimétricos (ej. 10 Mbps para Nivel 1, 15 Mbps para Nivel 2), impidiendo que descargas masivas o videos saturen la red del laboratorio.

### 5. Filtrado Web por Lista Blanca
* Enfoque educativo: en lugar de bloquear sitios uno por uno, la red funciona en modo **Lista Blanca**; los alumnos únicamente pueden navegar en las plataformas educativas y académicas expresamente autorizadas por el docente (Wikipedia, GitHub, Classroom, etc.).
* El router aplica esta política mediante registros en `/ip/dns/static`.

### 6. Distribución de Archivos y Visor Embebido (PDF.js)
* El docente puede subir guías de trabajos prácticos, códigos fuente, apuntes o ejercicios en formatos PDF, imágenes, texto, Python o archivos comprimidos.
* Los alumnos pueden previsualizar los archivos PDF directamente en un modal embebido gracias a **PDF.js**, sin necesidad de contar con lectores externos o conexión a internet exterior.

### 7. Comunicados en Red, Confirmación de Lectura ($x/y$) y Notificaciones Push
* El docente puede emitir comunicados con prioridad *Informativa*, *Aviso* o *Urgente*.
* El portal del alumno reproduce sonidos de campana sintetizados (Web Audio API) y activa la vibración en celulares.
* **Notificaciones en Segundo Plano**: Mediante un **Service Worker** (`sw.js`), las notificaciones llegan a la barra de estado de Android y al centro de notificaciones de la PC aunque la pestaña esté minimizada o el teléfono bloqueado.
* **Botón `✓ Marcar como leído`**: Guarda el acuse de recibo de forma persistente en `localStorage` y en la base de datos para que el anuncio no vuelva a aparecer al recargar.
* En el panel del docente se visualiza el contador en tiempo real:
  $$\text{👁️ } \text{confirmaron lectura} \text{ / } \text{total conectados} \quad (\%)$$

### 8. Doble Modo Visual: Modo Oscuro & Modo Claro
* **Modo Oscuro**: Estética moderna con fondos oscuros, efectos de cristal (*glassmorphism*) y acentos cian/violeta.
* **Modo Claro (Alta Legibilidad)**: Diseñado con altos estándares de contraste visual (fondos blancos nítidos, texto oscuro `#0F172A`, botones y tablas 100% legibles bajo luz solar directa o proyectores de clase).

---

## 5. Requisitos Previos y Despliegue Rápido

### Requisitos:
* **Docker** y **Docker Compose** instalados en el equipo servidor.
* Router MikroTik encendido y conectado por red al servidor.

### Pasos de Despliegue:

1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/tu-usuario/Laboratorio2-Tacuri.git
   cd Laboratorio2-Tacuri
   ```

2. **Crear el archivo de configuración `.env`**:
   ```bash
   cp .env.example .env
   ```
   *(Ajustar si es necesario la IP del MikroTik y las contraseñas).*

3. **Iniciar los servicios**:
   ```bash
   docker-compose up --build -d
   ```

4. **Accesos del Sistema**:
   * **Panel del Docente / Administrador**: `http://localhost:3000`
   * **Portal Cautivo del Alumno**: `http://localhost:3000/portal.html`
   * **Documentación Interactiva Swagger (API)**: `http://localhost:8000/docs`
   * **Base de Datos PostgreSQL**: `localhost:5432`

---

## 6. Configuración Inicial del Router MikroTik

Para que el backend pueda comunicarse con el router, se deben realizar estos tres pasos sencillos por única vez mediante Winbox:

1. **Habilitar el servicio API**:
   * En `IP → Services`, habilitar el servicio `api` (puerto `8728`).
2. **Crear el usuario API**:
   * En `System → Users`, crear el usuario `api-lab` con grupo `write` o `full` y la contraseña definida en el archivo `.env`.
3. **Crear la regla de Firewall para aislamiento**:
   * En `IP → Firewall → Filter Rules`, agregar una regla:
     * **Chain**: `forward`
     * **Src. Address List**: `blocked-devices`
     * **Action**: `drop`
     * *Comentario*: `Drop blocked and unapproved devices`

---

## 7. Endpoints Clave de la API

| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| `POST` | `/auth/token` | Inicio de sesión administrativo y entrega de JWT. |
| `POST` | `/devices/sync` | Sincroniza leases DHCP y detecta nuevos equipos. |
| `POST` | `/devices/{id}/approve` | Autoriza al equipo, aplica cola QoS y reserva IP fija. |
| `POST` | `/devices/{id}/reject` | Bloquea la salida a internet de la estación. |
| `GET` | `/sessions/active` | Consulta las sesiones de trabajo en curso. |
| `GET` | `/stats/dashboard` | Retorna KPIs, consumo promedio y uptime del router. |
| `GET` | `/web-filter/` | Lista las reglas activas de filtrado web. |
| `POST` | `/files/upload` | Subida de guías y archivos para los alumnos. |
| `GET` | `/files/{id}/view` | Streaming para visor PDF integrado. |
| `POST` | `/messages/` | Emisión de comunicados y alertas en la red. |
| `GET` | `/messages/` | Listado de comunicados con contador de confirmación $x/y$. |
| `POST` | `/messages/{id}/read` | Registra que el alumno marcó el comunicado como leído. |
| `GET` | `/portal/status` | Telemetría para el portal cautivo del estudiante. |

---

## 8. Auditoría del Proyecto: ¿Nos falta algo?

A continuación se presenta un balance técnico honesto sobre el estado del proyecto frente a los requerimientos de la cátedra:

### ✅ Aspectos Completados al 100%:
* Despliegue con Docker Compose en 1 comando (BD, API, Nginx).
* Vinculación en tiempo real con RouterOS mediante API nativa.
* Asignación de IP estática única para prevenir colisiones en el DHCP.
* Aprobación / rechazo de estaciones con reglas de firewall automáticas.
* Control de ancho de banda QoS adaptativo por rol.
* Control temporal de sesiones con detección de inactividad por bytes de red.
* Filtrado web por lista blanca y sincronización con el DNS del router.
* Sala de espera y portal cautivo para estudiantes.
* Distribución y visor embebido de archivos PDF sin internet.
* Comunicados con Service Worker, notificaciones push nativas y acuse de recibo $x/y$.
* Doble interfaz visual (Modo Oscuro / Modo Claro de alto contraste).

### 🔍 Mejoras y Extensiones Opcionales (Futuras Fases):
1. **Worker Autónomo en Segundo Plano (Background Cron)**:
   * *Estado actual*: La sincronización de leases y sesiones se dispara periódicamente cuando el panel administrativo o el portal del alumno están abiertos en el navegador.
   * *Mejora futura*: Añadir una tarea en segundo plano con `APScheduler` o `Celery` dentro del contenedor del backend para que audite las sesiones cada 60 segundos incluso si ningún usuario tiene la página web abierta.
2. **Exportación de Reportes a PDF / Excel**:
   * *Estado actual*: Las estadísticas e historial se visualizan interactivamente en pantalla mediante Chart.js y tablas.
   * *Mejora futura*: Incorporar un botón "Exportar Asistencia y Uso" que descargue una planilla `.xlsx` o un informe imprimible con las horas trabajadas por cada alumno.
3. **Notificaciones Externas por Bot de Telegram**:
   * *Estado actual*: Las alertas funcionan dentro de la red local (web y notificaciones de sistema operativo).
   * *Mejora futura*: Enviar un mensaje de Telegram al celular del docente cuando un alumno no autorizado intente conectarse fuera del horario de clase.

---

## 9. Estructura Detallada de Archivos

Para conocer el detalle exhaustivo de cada archivo del proyecto, sus métodos internos, modelos de base de datos y la justificación técnica de cada librería utilizada, consulta el documento técnico complementario:

👉 **[ESTRUCTURA_Y_ARCHIVOS.md](ESTRUCTURA_Y_ARCHIVOS.md)**
