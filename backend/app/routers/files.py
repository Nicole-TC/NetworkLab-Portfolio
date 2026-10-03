import os
import uuid
import base64
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import ArchivoCompartido

router = APIRouter(prefix="/files", tags=["files"])

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


class ArchivoSubidaJSON(BaseModel):
    nombre_original: str
    contenido_base64: str
    descripcion: str | None = None
    alcance: str = "todos"
    tipo_mime: str | None = "application/octet-stream"


@router.get("/")
def list_files(rol: str | None = None, db: Session = Depends(get_db)):
    """Lista todos los materiales y archivos compartidos disponibles."""
    query = db.query(ArchivoCompartido)
    if rol and rol in ("nivel_1", "nivel_2"):
        query = query.filter((ArchivoCompartido.alcance == "todos") | (ArchivoCompartido.alcance == rol))
    archivos = query.order_by(ArchivoCompartido.fecha_subida.desc()).all()
    return [
        {
            "id": a.id,
            "nombre_archivo": a.nombre_archivo,
            "nombre_original": a.nombre_original,
            "descripcion": a.descripcion,
            "tamano_bytes": a.tamano_bytes,
            "tipo_mime": a.tipo_mime,
            "alcance": a.alcance,
            "fecha_subida": a.fecha_subida,
            "subido_por": a.subido_por,
        }
        for a in archivos
    ]


@router.post("/upload")
def upload_file_json(data: ArchivoSubidaJSON, db: Session = Depends(get_db)):
    """Sube un archivo codificado en Base64 sin depender de librerías externas."""
    if not data.nombre_original.strip():
        raise HTTPException(status_code=400, detail="El nombre del archivo es obligatorio")

    raw_b64 = data.contenido_base64
    if "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1]

    try:
        file_bytes = base64.b64decode(raw_b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail="Formato Base64 inválido")

    ext = os.path.splitext(data.nombre_original)[1]
    safe_name = f"{int(datetime.now().timestamp())}_{uuid.uuid4().hex[:8]}{ext}"
    dest_path = os.path.join(UPLOAD_DIR, safe_name)

    try:
        with open(dest_path, "wb") as f:
            f.write(file_bytes)
        file_size = len(file_bytes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error guardando archivo en disco: {str(e)}")

    nuevo = ArchivoCompartido(
        nombre_archivo=safe_name,
        nombre_original=data.nombre_original.strip(),
        descripcion=(data.descripcion or "").strip() or None,
        tamano_bytes=file_size,
        tipo_mime=data.tipo_mime or "application/octet-stream",
        alcance=data.alcance or "todos",
        fecha_subida=datetime.now(),
        subido_por="Administrador",
    )
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    return {"ok": True, "archivo": nuevo, "mensaje": "Archivo subido exitosamente"}


@router.get("/{file_id}/download")
def download_file(file_id: int, db: Session = Depends(get_db)):
    """Descarga un archivo compartido por su ID."""
    archivo = db.query(ArchivoCompartido).filter(ArchivoCompartido.id == file_id).first()
    if not archivo:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    file_path = os.path.join(UPLOAD_DIR, archivo.nombre_archivo)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="El archivo físico no se encuentra en el servidor")

    return FileResponse(
        path=file_path,
        filename=archivo.nombre_original,
        media_type=archivo.tipo_mime or "application/octet-stream",
    )


@router.delete("/{file_id}")
def delete_file(file_id: int, db: Session = Depends(get_db)):
    """Elimina un archivo compartido del sistema y del disco."""
    archivo = db.query(ArchivoCompartido).filter(ArchivoCompartido.id == file_id).first()
    if not archivo:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")

    file_path = os.path.join(UPLOAD_DIR, archivo.nombre_archivo)
    if os.path.exists(file_path):
        try:
            os.remove(file_path)
        except Exception as e:
            print(f"Nota al borrar archivo físico: {e}")

    db.delete(archivo)
    db.commit()
    return {"ok": True, "mensaje": "Archivo eliminado correctamente"}
