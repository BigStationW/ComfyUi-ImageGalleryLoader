"""__init__.py"""

import os
import json
import folder_paths
import server
from aiohttp import web
import urllib.parse
from PIL import Image, ImageOps
import numpy as np
import torch
import hashlib
import time
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
import threading
import io
try:
    from send2trash import send2trash
    HAS_SEND2TRASH = True
except ImportError:
    HAS_SEND2TRASH = False
    print("Warning: send2trash not installed. Deleted images will be permanently removed.")
    print("Install with: pip install send2trash")

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
UI_STATE_FILE = os.path.join(NODE_DIR, "image_gallery_ui_state.json")
CACHE_DIR = os.path.join(NODE_DIR, "thumbnail_cache")
CACHE_DIR_PAD = os.path.join(NODE_DIR, "thumbnail_cache_pad")
IMAGE_EXTENSIONS = frozenset(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'])
CUSTOM_FOLDERS_FILE = os.path.join(NODE_DIR, "custom_source_folders.json")

WEB_DIRECTORY = "./js"

# Ensure cache directories exist
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(CACHE_DIR_PAD, exist_ok=True)

# Thread pool for background operations
_executor = ThreadPoolExecutor(max_workers=4)

# === CACHING LAYER ===

class ImageCache:
    """Thread-safe cache for image metadata and directory listings."""
    
    def __init__(self, ttl=30):  # 30 second TTL
        self._cache = {}
        self._lock = threading.RLock()
        self._ttl = ttl
        self._metadata_cache = {}  # Separate cache for metadata (longer TTL)
        self._metadata_ttl = 300   # 5 minute TTL for metadata
    
    def _is_expired(self, entry, ttl):
        return time.time() - entry['time'] > ttl
    
    def get_directory_listing(self, input_dir):
        """Get cached directory listing or refresh if expired."""
        cache_key = f"dir:{input_dir}"
        
        with self._lock:
            if cache_key in self._cache:
                entry = self._cache[cache_key]
                if not self._is_expired(entry, self._ttl):
                    return entry['data']
        
        # Refresh cache
        images, folders, mtimes = self._scan_directory(input_dir)
        
        with self._lock:
            self._cache[cache_key] = {
                'time': time.time(),
                'data': (images, folders, mtimes)
            }
        
        return images, folders, mtimes
    
    def _scan_directory(self, input_dir):
        """Scan directory and return images, folders, and modification times."""
        images = []
        folders = set()
        mtimes = {}
        
        if not os.path.exists(input_dir):
            return images, [], mtimes
        
        # Only scan the top-level directory, not subdirectories
        try:
            for entry in os.scandir(input_dir):
                if entry.is_dir():
                    # Add subfolder to the list (for folder navigation if needed)
                    folders.add(entry.name)
                elif entry.is_file():
                    ext = os.path.splitext(entry.name)[1].lower()
                    if ext in IMAGE_EXTENSIONS:
                        images.append(entry.name)
                        try:
                            mtimes[entry.name] = entry.stat().st_mtime
                        except OSError:
                            mtimes[entry.name] = 0
        except OSError as e:
            print(f"Error scanning directory {input_dir}: {e}")
            return images, [], mtimes
        
        return sorted(images, key=lambda x: x.lower()), sorted(list(folders), key=lambda x: x.lower()), mtimes
    
    def get_metadata_status(self, image_path, mtime):
        """Get cached metadata status for an image."""
        cache_key = f"meta:{image_path}:{mtime}"
        
        with self._lock:
            if cache_key in self._metadata_cache:
                entry = self._metadata_cache[cache_key]
                if not self._is_expired(entry, self._metadata_ttl):
                    return entry['data']
        
        return None
    
    def set_metadata_status(self, image_path, mtime, has_metadata):
        """Cache metadata status for an image."""
        cache_key = f"meta:{image_path}:{mtime}"
        
        with self._lock:
            self._metadata_cache[cache_key] = {
                'time': time.time(),
                'data': has_metadata
            }
    
    def invalidate(self):
        """Clear all caches."""
        with self._lock:
            self._cache.clear()
            # Keep metadata cache as it's based on mtime

_image_cache = ImageCache()


# === OPTIMIZED FUNCTIONS ===

def load_json_file(file_path, default_data={}):
    if not os.path.exists(file_path):
        return default_data
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            if not content:
                return default_data
            return json.loads(content)
    except Exception as e:
        print(f"Error loading {file_path}: {e}")
        return default_data

def save_json_file(data, file_path):
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving {file_path}: {e}")

load_ui_state = lambda: load_json_file(UI_STATE_FILE)
save_ui_state = lambda data: save_json_file(data, UI_STATE_FILE)


def has_comfyui_metadata_fast(image_path, mtime=None):
    """
    Check if a PNG file has ComfyUI metadata with caching.
    """
    if not image_path.lower().endswith('.png'):
        return False
    
    if mtime is None:
        try:
            mtime = os.path.getmtime(image_path)
        except OSError:
            mtime = 0
    
    # Check cache first
    cached = _image_cache.get_metadata_status(image_path, mtime)
    if cached is not None:
        return cached
    
    # Read metadata from file
    try:
        with open(image_path, 'rb') as f:
            # Read PNG signature + IHDR
            header = f.read(33)
            if len(header) < 8 or header[:8] != b'\x89PNG\r\n\x1a\n':
                _image_cache.set_metadata_status(image_path, mtime, False)
                return False
            
            # Scan for tEXt chunks containing 'prompt' or 'workflow'
            f.seek(8)  # Skip signature
            has_meta = False
            
            while True:
                chunk_header = f.read(8)
                if len(chunk_header) < 8:
                    break
                
                length = int.from_bytes(chunk_header[:4], 'big')
                chunk_type = chunk_header[4:8]
                
                if chunk_type in (b'tEXt', b'iTXt'):
                    # Read chunk data to check for keywords
                    chunk_data = f.read(min(length, 1024))  # Read up to 1KB
                    if b'prompt' in chunk_data or b'workflow' in chunk_data:
                        has_meta = True
                        break
                    f.seek(length - len(chunk_data) + 4, 1)  # Skip rest + CRC
                elif chunk_type == b'IEND':
                    break
                else:
                    f.seek(length + 4, 1)  # Skip chunk data + CRC
            
            _image_cache.set_metadata_status(image_path, mtime, has_meta)
            return has_meta
            
    except Exception:
        _image_cache.set_metadata_status(image_path, mtime, False)
        return False


def get_input_images_optimized(subfolder="", metadata_filter="all", sort_by="name", source_folder=""):
    """Optimized image listing with caching and multiple source folder support."""
    
    # Handle "ALL" source folder - scan all configured folders
    if source_folder == "__ALL__":
        all_images = []
        all_folders = set()
        all_mtimes = {}
        
        folders = load_source_folders()
        for folder_config in folders:
            folder_path = folder_config.get('path', '')
            if not folder_path or not os.path.exists(folder_path):
                continue
            
            images, folders_list, mtimes = _image_cache.get_directory_listing(folder_path)
            
            # Prefix images with folder name for uniqueness
            folder_name = folder_config.get('name', os.path.basename(folder_path))
            for img in images:
                prefixed_name = f"[{folder_name}] {img}"
                all_images.append({
                    'name': prefixed_name,
                    'original_name': img,
                    'source_folder': folder_path,
                    'mtime': mtimes.get(img, 0)
                })
                all_mtimes[prefixed_name] = mtimes.get(img, 0)
            
            all_folders.update(folders_list)
        
        # Apply metadata filter
        if metadata_filter != "all":
            filtered_images = []
            for img_data in all_images:
                full_path = os.path.join(img_data['source_folder'], img_data['original_name'])
                has_meta = has_comfyui_metadata_fast(full_path, img_data['mtime'])
                
                if metadata_filter == "with" and has_meta:
                    filtered_images.append(img_data)
                elif metadata_filter == "without" and not has_meta:
                    filtered_images.append(img_data)
            all_images = filtered_images
        
        # Apply sorting
        if sort_by == "date":
            all_images = sorted(all_images, key=lambda x: x['mtime'], reverse=True)
        elif sort_by == "date_asc":
            all_images = sorted(all_images, key=lambda x: x['mtime'])
        else:
            all_images = sorted(all_images, key=lambda x: x['name'].lower())
        
        return all_images, sorted(list(all_folders)), all_mtimes, "__ALL__"
    
    # Original single folder logic
    if source_folder:
        folders = load_source_folders()
        source_folder_norm = os.path.normpath(source_folder)
        valid_source = any(os.path.normpath(f.get('path', '')) == source_folder_norm for f in folders)
        
        if valid_source and os.path.exists(source_folder) and os.path.isdir(source_folder):
            input_dir = source_folder
        else:
            input_dir = folder_paths.get_input_directory()
    else:
        input_dir = folder_paths.get_input_directory()
    
    # Get cached directory listing
    all_images, all_folders, mtimes = _image_cache.get_directory_listing(input_dir)
    
    # Filter by subfolder - REMOVED since we're removing subfolder filtering
    # if subfolder:
    #     ...
    
    # Apply metadata filter (only if needed)
    if metadata_filter != "all":
        filtered_images = []
        for img in all_images:
            full_path = os.path.join(input_dir, img)
            mtime = mtimes.get(img, 0)
            has_meta = has_comfyui_metadata_fast(full_path, mtime)
            
            if metadata_filter == "with" and has_meta:
                filtered_images.append(img)
            elif metadata_filter == "without" and not has_meta:
                filtered_images.append(img)
        
        all_images = filtered_images
    
    # Apply sorting
    if sort_by == "date":
        all_images = sorted(all_images, key=lambda x: mtimes.get(x, 0), reverse=True)
    elif sort_by == "date_asc":
        all_images = sorted(all_images, key=lambda x: mtimes.get(x, 0))
    else:
        all_images = sorted(all_images, key=lambda x: x.lower())
    
    # Convert to consistent format
    image_list = []
    for img in all_images:
        image_list.append({
            'name': img,
            'original_name': img,
            'source_folder': input_dir,
            'mtime': mtimes.get(img, 0)
        })
    
    return image_list, all_folders, mtimes, input_dir

def get_thumbnail_path(image_path, mode='crop'):
    """Get path to cached thumbnail. mode is 'crop' or 'pad'."""
    # Create hash of path + mtime for cache key
    try:
        mtime = os.path.getmtime(image_path)
    except OSError:
        mtime = 0
    
    cache_key = hashlib.md5(f"{image_path}:{mtime}".encode()).hexdigest()
    cache_dir = CACHE_DIR_PAD if mode == 'pad' else CACHE_DIR
    return os.path.join(cache_dir, f"{cache_key}.webp")


def generate_thumbnail(image_path, max_size=400, mode='crop'):  # Doubled from 200
    """Generate and cache a thumbnail.
    
    mode='crop': fit image inside max_size (aspect preserved); CSS may crop via object-fit:cover.
    mode='pad': fit image inside a max_size x max_size square and pad with solid black #000000.
    """
    if mode not in ('crop', 'pad'):
        mode = 'crop'
    
    thumb_path = get_thumbnail_path(image_path, mode)
    
    if os.path.exists(thumb_path):
        return thumb_path
    
    try:
        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            
            if mode == 'pad':
                # Convert to RGB on black background for transparency
                if img.mode in ('RGBA', 'LA', 'P'):
                    background = Image.new('RGB', img.size, (0, 0, 0))
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
                    img = background
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # Fit inside max_size maintaining aspect ratio
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                
                # Pad to square with solid black #000000
                canvas = Image.new('RGB', (max_size, max_size), (0, 0, 0))
                offset = ((max_size - img.width) // 2, (max_size - img.height) // 2)
                canvas.paste(img, offset)
                img = canvas
            else:
                # Crop/fit mode: existing behavior (fit inside, dark gray bg for alpha)
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                
                if img.mode in ('RGBA', 'LA', 'P'):
                    background = Image.new('RGB', img.size, (30, 30, 30))
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
                    img = background
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
            
            # Quality 92, method 4 for good speed/quality balance
            img.save(thumb_path, 'WEBP', quality=92, method=4)
            return thumb_path
    except Exception as e:
        print(f"Error generating thumbnail for {image_path}: {e}")
        return None

def load_source_folders():
    """Load custom source folder paths from config file."""
    input_dir = folder_paths.get_input_directory()
    default_folder = {"path": input_dir, "name": "input", "is_default": True}
    
    if not os.path.exists(CUSTOM_FOLDERS_FILE):
        return [default_folder]
    
    try:
        with open(CUSTOM_FOLDERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            folders = data.get('folders', [])
            
            # Normalize paths and filter out non-existent folders
            valid_folders = []
            for f in folders:
                path = os.path.normpath(f.get('path', ''))
                if os.path.exists(path) and os.path.isdir(path):
                    valid_folders.append({
                        "path": path,
                        "name": f.get('name', os.path.basename(path)),
                        "is_default": f.get('is_default', False)
                    })
            
            # Always ensure input folder is first
            input_dir_norm = os.path.normpath(input_dir)
            has_input = any(os.path.normpath(f.get('path', '')) == input_dir_norm for f in valid_folders)
            if not has_input:
                valid_folders.insert(0, default_folder)
            else:
                # Move input to first position if it exists
                for i, f in enumerate(valid_folders):
                    if os.path.normpath(f.get('path', '')) == input_dir_norm:
                        f['is_default'] = True
                        if i != 0:
                            valid_folders.insert(0, valid_folders.pop(i))
                        break
            
            return valid_folders
    except Exception as e:
        print(f"Error loading custom source folders: {e}")
        return [default_folder]


def save_source_folders(folders):
    """Save custom source folder paths to config file."""
    try:
        with open(CUSTOM_FOLDERS_FILE, 'w', encoding='utf-8') as f:
            json.dump({"folders": folders}, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving custom source folders: {e}")

# === API ENDPOINTS ===

@server.PromptServer.instance.routes.post("/imagegallery/browse_folder")
async def browse_folder(request):
    """Open native folder picker dialog and return selected path."""
    import asyncio
    import subprocess
    import sys
    
    def open_folder_dialog():
        """Open folder dialog in a separate thread to avoid blocking."""
        
        # Windows: Use PowerShell with OpenFileDialog configured for folders
        if sys.platform == 'win32':
            try:
                powershell_script = '''
                Add-Type -AssemblyName System.Windows.Forms
                
                $dialog = New-Object System.Windows.Forms.OpenFileDialog
                $dialog.ValidateNames = $false
                $dialog.CheckFileExists = $false
                $dialog.CheckPathExists = $true
                $dialog.Title = "Select Source Folder for Image Gallery"
                $dialog.FileName = "Folder Selection"
                $dialog.Filter = "Folders|*.folder"
                
                # Create a form to be the parent and bring to front
                $form = New-Object System.Windows.Forms.Form
                $form.TopMost = $true
                $form.MinimizeBox = $false
                $form.MaximizeBox = $false
                $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
                $form.ShowInTaskbar = $false
                $form.Show()
                $form.Activate()
                
                $result = $dialog.ShowDialog($form)
                $form.Close()
                
                if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
                    $folderPath = Split-Path -Parent $dialog.FileName
                    Write-Output $folderPath
                } else {
                    Write-Output "::CANCELLED::"
                }
                '''
                
                # Run PowerShell with hidden window
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0  # SW_HIDE
                
                result = subprocess.run(
                    ['powershell', '-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', powershell_script],
                    capture_output=True,
                    text=True,
                    startupinfo=startupinfo,
                    timeout=120  # 2 minute timeout
                )
                
                folder_path = result.stdout.strip()
                
                if folder_path == "::CANCELLED::" or not folder_path:
                    return {"cancelled": True}
                
                if os.path.isdir(folder_path):
                    return {"path": os.path.normpath(folder_path), "cancelled": False}
                else:
                    return {"cancelled": True}
                    
            except subprocess.TimeoutExpired:
                return {"error": "Folder dialog timed out. Please try again."}
            except Exception as e:
                print(f"PowerShell folder dialog failed: {e}")
                # Fall through to tkinter
        
        # Try tkinter (cross-platform fallback)
        try:
            import tkinter as tk
            from tkinter import filedialog
            
            root = tk.Tk()
            root.withdraw()
            
            # Make sure dialog appears on top
            root.wm_attributes('-topmost', 1)
            root.focus_force()
            
            # On Windows, also try to lift the window
            if sys.platform == 'win32':
                root.lift()
                root.attributes('-topmost', True)
                root.after_idle(root.attributes, '-topmost', False)
            
            folder_path = filedialog.askdirectory(
                parent=root,
                title="Select Source Folder for Image Gallery",
                mustexist=True
            )
            
            root.destroy()
            
            if folder_path:
                return {"path": os.path.normpath(folder_path), "cancelled": False}
            else:
                return {"cancelled": True}
                
        except ImportError:
            pass
        except Exception as tk_error:
            print(f"Tkinter folder dialog failed: {tk_error}")
        
        # Linux/Mac: Try zenity or kdialog
        if sys.platform != 'win32':
            try:
                # Try zenity first (common on GNOME)
                result = subprocess.run(
                    ['zenity', '--file-selection', '--directory', '--title=Select Source Folder'],
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                if result.returncode == 0:
                    folder_path = result.stdout.strip()
                    if folder_path and os.path.isdir(folder_path):
                        return {"path": os.path.normpath(folder_path), "cancelled": False}
                return {"cancelled": True}
            except FileNotFoundError:
                pass
            except Exception:
                pass
            
            try:
                # Try kdialog (common on KDE)
                result = subprocess.run(
                    ['kdialog', '--getexistingdirectory', '--title', 'Select Source Folder'],
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                if result.returncode == 0:
                    folder_path = result.stdout.strip()
                    if folder_path and os.path.isdir(folder_path):
                        return {"path": os.path.normpath(folder_path), "cancelled": False}
                return {"cancelled": True}
            except FileNotFoundError:
                pass
            except Exception:
                pass
        
        return {"error": "No folder dialog available. Please install tkinter or use manual path entry."}
    
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, open_folder_dialog)
        
        if "error" in result:
            return web.json_response({"error": result["error"]}, status=500)
        
        return web.json_response(result)
        
    except Exception as e:
        import traceback
        print(f"Error in browse_folder: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.post("/imagegallery/paste_image")
async def paste_image(request):
    """Handle pasted image from clipboard."""
    try:
        data = await request.post()
        
        if 'image' not in data:
            return web.json_response({"error": "No image data provided"}, status=400)
        
        image_field = data['image']
        
        # Read image data
        image_data = image_field.file.read()
        
        # Generate filename with timestamp
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"pasted_image_{timestamp}.png"
        
        # Get input directory
        input_dir = folder_paths.get_input_directory()
        filepath = os.path.join(input_dir, filename)
        
        # Save the image
        with open(filepath, 'wb') as f:
            f.write(image_data)
        
        # Invalidate cache
        _image_cache.invalidate()
        
        return web.json_response({
            "status": "ok",
            "filename": filename,
            "message": f"Image pasted successfully as {filename}"
        })
        
    except Exception as e:
        import traceback
        print(f"Error in paste_image: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/imagegallery/get_source_folders")
async def get_source_folders(request):
    """Get list of configured source folders."""
    try:
        folders = load_source_folders()
        return web.json_response({"folders": folders})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/imagegallery/add_source_folder")
async def add_source_folder(request):
    """Add a new source folder to the configuration."""
    try:
        data = await request.json()
        folder_path = data.get("path", "").strip()
        folder_name = data.get("name", "").strip()
        
        if not folder_path:
            return web.json_response({"error": "Path is required"}, status=400)
        
        # Normalize path
        folder_path = os.path.normpath(folder_path)
        
        # Validate path exists and is a directory
        if not os.path.exists(folder_path):
            return web.json_response({"error": f"Path does not exist: {folder_path}"}, status=400)
        
        if not os.path.isdir(folder_path):
            return web.json_response({"error": f"Path is not a directory: {folder_path}"}, status=400)
        
        # Generate name if not provided
        if not folder_name:
            folder_name = os.path.basename(folder_path) or folder_path
        
        folders = load_source_folders()
        
        # Check if already exists
        if any(os.path.normpath(f.get('path', '')) == folder_path for f in folders):
            return web.json_response({"error": "Folder already exists in the list"}, status=400)
        
        folders.append({"path": folder_path, "name": folder_name, "is_default": False})
        save_source_folders(folders)
        
        # Invalidate cache
        _image_cache.invalidate()
        
        return web.json_response({"status": "ok", "folders": folders})
    except Exception as e:
        import traceback
        print(f"Error adding source folder: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)
    
@server.PromptServer.instance.routes.post("/imagegallery/delete_image")
async def delete_image(request):
    """Delete an image from the gallery (moves to recycle bin)."""
    try:
        data = await request.json()
        image_name = data.get("image", "").strip()
        source_folder = data.get("source", "").strip()
        
        if not image_name:
            return web.json_response({"error": "Image name is required"}, status=400)
        
        # Determine base directory
        if source_folder:
            folders = load_source_folders()
            source_norm = os.path.normpath(source_folder)
            valid_source = any(os.path.normpath(f.get('path', '')) == source_norm for f in folders)
            
            if valid_source and os.path.exists(source_folder) and os.path.isdir(source_folder):
                input_dir = source_folder
            else:
                input_dir = folder_paths.get_input_directory()
        else:
            input_dir = folder_paths.get_input_directory()
        
        # Build and validate path
        image_path = os.path.normpath(os.path.join(input_dir, image_name))
        
        # Security check - ensure path is within allowed directory
        if not image_path.startswith(os.path.normpath(input_dir)):
            return web.json_response({"error": "Invalid image path"}, status=403)
        
        if not os.path.exists(image_path):
            return web.json_response({"error": "Image not found"}, status=404)
        
        if not os.path.isfile(image_path):
            return web.json_response({"error": "Path is not a file"}, status=400)
        
        # Delete thumbnail caches first (before moving original) — both crop and pad
        for mode in ('crop', 'pad'):
            thumb_path = get_thumbnail_path(image_path, mode=mode)
            if os.path.exists(thumb_path):
                try:
                    os.remove(thumb_path)  # Thumbnail can be permanently deleted
                except:
                    pass
        
        # Move to recycle bin or delete permanently
        if HAS_SEND2TRASH:
            send2trash(image_path)
            method = "recycled"
        else:
            os.remove(image_path)
            method = "deleted"
        
        # Invalidate cache
        _image_cache.invalidate()
        
        return web.json_response({"status": "ok", "message": f"Image {method}: {image_name}", "method": method})
        
    except Exception as e:
        import traceback
        print(f"Error deleting image: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.post("/imagegallery/remove_source_folder")
async def remove_source_folder(request):
    """Remove a source folder from the configuration."""
    try:
        data = await request.json()
        folder_path = data.get("path", "").strip()
        
        if not folder_path:
            return web.json_response({"error": "Path is required"}, status=400)
        
        folder_path = os.path.normpath(folder_path)
        folders = load_source_folders()
        
        # Don't allow removing default input folder
        input_dir = os.path.normpath(folder_paths.get_input_directory())
        if folder_path == input_dir:
            return web.json_response({"error": "Cannot remove the default input folder"}, status=400)
        
        # Filter out the folder to remove
        new_folders = [f for f in folders if os.path.normpath(f.get('path', '')) != folder_path]
        
        if len(new_folders) == len(folders):
            return web.json_response({"error": "Folder not found in the list"}, status=400)
        
        save_source_folders(new_folders)
        
        # Invalidate cache
        _image_cache.invalidate()
        
        return web.json_response({"status": "ok", "folders": new_folders})
    except Exception as e:
        import traceback
        print(f"Error removing source folder: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)
    
@server.PromptServer.instance.routes.get("/imagegallery/get_images")
async def get_images_endpoint(request):
    try:
        page = int(request.query.get('page', 1))
        per_page = int(request.query.get('per_page', 100))
        search = request.query.get('search', '').lower()
        metadata_filter = request.query.get('metadata', 'all')
        sort_by = request.query.get('sort', 'name')
        source_folder = request.query.get('source', '')
        
        if metadata_filter not in ['all', 'with', 'without']:
            metadata_filter = 'all'
        
        if sort_by not in ['name', 'date', 'date_asc']:
            sort_by = 'name'
        
        if source_folder:
            source_folder = urllib.parse.unquote(source_folder)
        
        all_images, all_folders, mtimes, used_input_dir = get_input_images_optimized(
            "", metadata_filter, sort_by, source_folder
        )
        
        if search:
            all_images = [img for img in all_images if search in img['name'].lower()]
        
        total_images = len(all_images)
        total_pages = max(1, (total_images + per_page - 1) // per_page)
        
        start_index = (page - 1) * per_page
        end_index = start_index + per_page
        paginated_images = all_images[start_index:end_index]
        
        image_info_list = []
        for img_data in paginated_images:
            encoded_name = urllib.parse.quote(img_data['original_name'], safe='')
            encoded_source = urllib.parse.quote(img_data['source_folder'], safe='')
            mtime = img_data.get('mtime', 0)
            
            # Get image dimensions
            width, height = 0, 0
            try:
                full_path = os.path.join(img_data['source_folder'], img_data['original_name'])
                with Image.open(full_path) as img:
                    width, height = img.size
            except Exception as e:
                pass  # Keep as 0, 0 if unable to read
            
            image_info_list.append({
                "name": img_data['name'],
                "original_name": img_data['original_name'],
                "preview_url": f"/imagegallery/thumb?filename={encoded_name}&source={encoded_source}&t={int(mtime)}",
                "source": img_data['source_folder'],
                "width": width,
                "height": height
            })
        
        return web.json_response({
            "images": image_info_list,
            "folders": all_folders,
            "total_pages": total_pages,
            "current_page": page,
            "source_folder": used_input_dir
        })
    except Exception as e:
        import traceback
        print(f"Error in get_images_endpoint: {traceback.format_exc()}")
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/imagegallery/thumb")
async def get_thumbnail(request):
    """Serve optimized thumbnails instead of full images."""
    filename = request.query.get('filename')
    source = request.query.get('source', '')
    mode = request.query.get('mode', 'crop')
    if mode not in ('crop', 'pad'):
        mode = 'crop'
    
    if not filename:
        return web.Response(status=400, text="Missing filename parameter")
    
    try:
        filename_decoded = urllib.parse.unquote(filename)
        source_decoded = urllib.parse.unquote(source) if source else ''
        
        if ".." in filename_decoded:
            return web.Response(status=403, text="Invalid filename")
        
        # Determine base directory
        if source_decoded:
            # Validate source is in our configured list
            folders = load_source_folders()
            source_norm = os.path.normpath(source_decoded)
            valid_source = any(os.path.normpath(f.get('path', '')) == source_norm for f in folders)
            
            if valid_source and os.path.exists(source_decoded) and os.path.isdir(source_decoded):
                input_dir = source_decoded
            else:
                input_dir = folder_paths.get_input_directory()
        else:
            input_dir = folder_paths.get_input_directory()
        
        image_path = os.path.normpath(os.path.join(input_dir, filename_decoded))
        
        # Security check
        if not image_path.startswith(os.path.normpath(input_dir)):
            return web.Response(status=403, text="Access denied")
        
        if not os.path.exists(image_path):
            return web.Response(status=404, text="Image not found")
        
        # Generate or get cached thumbnail (crop or pad cache)
        thumb_path = generate_thumbnail(image_path, mode=mode)
        
        if thumb_path and os.path.exists(thumb_path):
            return web.FileResponse(thumb_path, headers={
                'Cache-Control': 'public, max-age=86400',
                'Content-Type': 'image/webp'
            })
        else:
            return web.FileResponse(image_path)
            
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/imagegallery/preview")
async def get_preview_image(request):
    """Full image preview (for when user needs full resolution)."""
    filename = request.query.get('filename')
    source = request.query.get('source', '')
    
    if not filename:
        return web.Response(status=400, text="Missing filename parameter")
    
    try:
        filename_decoded = urllib.parse.unquote(filename)
        source_decoded = urllib.parse.unquote(source) if source else ''
        
        if ".." in filename_decoded:
            return web.Response(status=403, text="Invalid filename")
        
        # Determine base directory
        if source_decoded:
            folders = load_source_folders()
            source_norm = os.path.normpath(source_decoded)
            valid_source = any(os.path.normpath(f.get('path', '')) == source_norm for f in folders)
            
            if valid_source and os.path.exists(source_decoded) and os.path.isdir(source_decoded):
                input_dir = source_decoded
            else:
                input_dir = folder_paths.get_input_directory()
        else:
            input_dir = folder_paths.get_input_directory()
        
        image_path = os.path.normpath(os.path.join(input_dir, filename_decoded))
        
        if not image_path.startswith(os.path.normpath(input_dir)):
            return web.Response(status=403, text="Access denied")
        
        if os.path.exists(image_path) and os.path.isfile(image_path):
            return web.FileResponse(image_path, headers={
                'Cache-Control': 'public, max-age=3600'
            })
        else:
            return web.Response(status=404, text=f"Image '{filename_decoded}' not found.")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)



def cleanup_orphaned_thumbnails():
    """Remove thumbnails for images that no longer exist (both crop and pad caches)."""
    try:
        # Get all valid source folders
        folders = load_source_folders()
        valid_dirs = [folder_paths.get_input_directory()]
        for folder in folders:
            path = folder.get('path', '')
            if path and os.path.exists(path) and os.path.isdir(path):
                valid_dirs.append(path)
        
        # Build set of existing image hashes
        existing_hashes = set()
        for input_dir in valid_dirs:
            if not os.path.exists(input_dir):
                continue
            
            try:
                for entry in os.scandir(input_dir):
                    if entry.is_file():
                        ext = os.path.splitext(entry.name)[1].lower()
                        if ext in IMAGE_EXTENSIONS:
                            # Generate the same hash that would be used for caching
                            # The actual cache key is "{full_path}:{mtime}"
                            full_path = os.path.join(input_dir, entry.name)
                            try:
                                mtime = entry.stat().st_mtime
                            except OSError:
                                mtime = 0
                            cache_key = f"{full_path}:{mtime}"
                            hash_name = hashlib.md5(cache_key.encode()).hexdigest()
                            existing_hashes.add(f"{hash_name}.webp")
            except OSError:
                continue
        
        removed_count = 0
        for cache_dir in (CACHE_DIR, CACHE_DIR_PAD):
            if not os.path.exists(cache_dir):
                continue
            
            cached_files = set()
            for filename in os.listdir(cache_dir):
                if filename.endswith('.webp'):
                    cached_files.add(filename)
            
            if not cached_files:
                continue
            
            # Remove orphaned thumbnails
            orphaned = cached_files - existing_hashes
            for orphaned_file in orphaned:
                try:
                    os.remove(os.path.join(cache_dir, orphaned_file))
                    removed_count += 1
                except OSError:
                    pass
        
        if removed_count > 0:
            print(f"Cleaned up {removed_count} orphaned thumbnails")
            
    except Exception as e:
        print(f"Error cleaning up thumbnails: {e}")


@server.PromptServer.instance.routes.post("/imagegallery/invalidate_cache")
async def invalidate_cache(request):
    """Endpoint to manually invalidate cache (called on refresh)."""
    _image_cache.invalidate()
    # Clean up orphaned thumbnails in background
    _executor.submit(cleanup_orphaned_thumbnails)
    return web.json_response({"status": "ok"})


@server.PromptServer.instance.routes.post("/imagegallery/set_ui_state")
async def set_ui_state(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id"))
        gallery_id = data.get("gallery_id")
        state = data.get("state", {})

        if not gallery_id:
            return web.Response(status=400)

        node_key = f"{gallery_id}_{node_id}"
        ui_states = load_ui_state()
        if node_key not in ui_states:
            ui_states[node_key] = {}
        ui_states[node_key].update(state)
        save_ui_state(ui_states)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/imagegallery/get_ui_state")
async def get_ui_state(request):
    try:
        node_id = request.query.get('node_id')
        gallery_id = request.query.get('gallery_id')

        if not node_id or not gallery_id:
            return web.json_response({"error": "node_id or gallery_id is required"}, status=400)

        node_key = f"{gallery_id}_{node_id}"
        ui_states = load_ui_state()
        node_state = ui_states.get(node_key, {"is_collapsed": False, "selected_image": "", "metadata_filter": "all"})
        return web.json_response(node_state)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


class LocalImageGallery:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "selected_image": ("STRING", {"default": ""}),
                "source_folder": ("STRING", {"default": ""})  # NEW
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "load_image"
    CATEGORY = "🖼️ Image Gallery"

    @classmethod
    def IS_CHANGED(cls, selected_image="", source_folder="", **kwargs):
        if not selected_image:
            return ""
        root_dir = source_folder if source_folder else folder_paths.get_input_directory()
        full_path = os.path.join(root_dir, selected_image)
        mtime = 0
        if os.path.exists(full_path):
            mtime = os.path.getmtime(full_path)

        return f"{full_path}:{mtime}"
    
    @classmethod
    def VALIDATE_INPUTS(cls, selected_image="", source_folder="", **kwargs):
        if not selected_image:
            return True
        
        # Determine input directory
        if source_folder:
            folders = load_source_folders()
            source_norm = os.path.normpath(source_folder)
            valid_source = any(os.path.normpath(f.get('path', '')) == source_norm for f in folders)
            
            if valid_source and os.path.exists(source_folder) and os.path.isdir(source_folder):
                input_dir = source_folder
            else:
                input_dir = folder_paths.get_input_directory()
        else:
            input_dir = folder_paths.get_input_directory()
        
        image_path = os.path.normpath(os.path.join(input_dir, selected_image))
        
        if not image_path.startswith(os.path.normpath(input_dir)):
            return f"Invalid image path: {selected_image}"
        
        if not os.path.exists(image_path):
            return f"Image not found: {selected_image}"
        
        return True

    def load_image(self, unique_id, selected_image="", source_folder="", **kwargs):
        if not selected_image:
            print("LocalImageGallery: No image selected, returning blank image.")
            blank = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (blank,)
        
        # Determine input directory
        if source_folder:
            folders = load_source_folders()
            source_norm = os.path.normpath(source_folder)
            valid_source = any(os.path.normpath(f.get('path', '')) == source_norm for f in folders)
            
            if valid_source and os.path.exists(source_folder) and os.path.isdir(source_folder):
                input_dir = source_folder
            else:
                input_dir = folder_paths.get_input_directory()
        else:
            input_dir = folder_paths.get_input_directory()
        
        image_path = os.path.normpath(os.path.join(input_dir, selected_image))
        
        if not image_path.startswith(os.path.normpath(input_dir)):
            print(f"LocalImageGallery: Invalid path attempted: {image_path}")
            blank = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (blank,)
        
        if not os.path.exists(image_path):
            print(f"LocalImageGallery: Image not found: {image_path}")
            blank = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (blank,)
        
        try:
            img = Image.open(image_path)
            img = ImageOps.exif_transpose(img)
            
            if img.mode == 'I':
                img = img.point(lambda i: i * (1 / 255))
            
            img = img.convert("RGB")
            
            img_array = np.array(img).astype(np.float32) / 255.0
            img_tensor = torch.from_numpy(img_array).unsqueeze(0)
            
            return (img_tensor,)
            
        except Exception as e:
            print(f"LocalImageGallery: Error loading image '{selected_image}': {e}")
            import traceback
            traceback.print_exc()
            blank = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            return (blank,)

NODE_CLASS_MAPPINGS = {
    "LocalImageGallery": LocalImageGallery
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LocalImageGallery": "Image Gallery Loader"
}

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
