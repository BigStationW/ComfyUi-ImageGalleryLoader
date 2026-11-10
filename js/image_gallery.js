// image_gallery.js

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { folderManager } from "./folder_manager.js"; 

const LocalImageGalleryNode = {
    name: "LocalImageGallery",
    
    _pendingStateUpdates: new Map(),
    _activeContextMenu: null,  // Track active context menu
    
    async setUiState(nodeId, galleryId, state) {
        const key = `${nodeId}-${galleryId}`;
        
        if (this._pendingStateUpdates.has(key)) {
            clearTimeout(this._pendingStateUpdates.get(key).timeout);
            state = { ...this._pendingStateUpdates.get(key).state, ...state };
        }
        
        const timeout = setTimeout(async () => {
            this._pendingStateUpdates.delete(key);
            try {
                await api.fetchApi("/imagegallery/set_ui_state", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ node_id: nodeId, gallery_id: galleryId, state }),
                });
            } catch(e) {
                console.error("LocalImageGallery: Failed to set UI state", e);
            }
        }, 1000);
        
        this._pendingStateUpdates.set(key, { timeout, state });
    },

    // Close any open context menu
    closeContextMenu() {
        if (this._activeContextMenu) {
            this._activeContextMenu.remove();
            this._activeContextMenu = null;
        }
    },

    setup(nodeType, nodeData) {
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            this._gallery = {
                isLoading: false,
                currentPage: 1,
                totalPages: 1,
                availableImages: [],
                availableFolders: [],
                selectedImage: "",
                selectedImageSource: "", 
                selectedOriginalName: "",
                selectedImageWidth: 0,
                selectedImageHeight: 0,
                currentFolder: "",
                currentSourceFolder: "",   
                availableSourceFolders: [], 
                metadataFilter: "all",
                sortOrder: "name",
                fitMode: "crop",
                previewSize: 110,
                foldersRendered: false,
                elements: {},
                cachedHeights: { controls: 0, selectedDisplay: 0 },
                visibleRange: { start: 0, end: 0 },
                cardHeight: 140,
                columnsCount: 4,
            };
            
            if (!this.properties) this.properties = {};
            if (!this.properties.image_gallery_unique_id) {
                this.properties.image_gallery_unique_id = "image-gallery-" + Math.random().toString(36).substring(2, 11);
            }

            const HEADER_HEIGHT = 80;
            const MIN_NODE_WIDTH = 450;
            const MIN_GALLERY_HEIGHT = 200;

            this.size = [550, 480];

            const node = this;
            const state = this._gallery;

            const originalConfigure = this.configure;
            this.configure = function(data) {
                const result = originalConfigure?.apply(this, arguments);
    
                return result;
            };

            // Hidden widgets
            const galleryIdWidget = this.addWidget("hidden_text", "image_gallery_unique_id_widget", 
                this.properties.image_gallery_unique_id, () => {}, {});
            galleryIdWidget.serializeValue = () => this.properties.image_gallery_unique_id;
            galleryIdWidget.draw = () => {};
            galleryIdWidget.computeSize = () => [0, 0];

            const selectionWidget = this.addWidget("hidden_text", "selected_image",
                this.properties.selected_image || "", () => {}, { multiline: false });
            selectionWidget.serializeValue = () => {
                const val = node.properties["selected_image"] || "";
                return val;
            };

            const sourceFolderWidget = this.addWidget("hidden_text", "source_folder",
                this.properties.source_folder || "", () => {}, { multiline: false });
            sourceFolderWidget.serializeValue = () => {
                const val = node.properties["source_folder"] || "";
                return val;
            };
            
            // Create container
            const widgetContainer = document.createElement("div");
            widgetContainer.className = "localimage-container-wrapper";
            widgetContainer.dataset.captureWheel = "true";
            widgetContainer.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

            this.addDOMWidget("gallery", "div", widgetContainer, {});

            const uniqueId = `localimage-gallery-${this.id}`;
            
            this._ensureGlobalStyles();
            
            widgetContainer.innerHTML = `
                <div id="${uniqueId}" class="localimage-root" style="height: 100%;">
                    <div class="localimage-container">
                        <div class="localimage-selected-display">
                            <span class="label">Selected:</span>
                            <span class="selected-name" title="">None</span>
                        </div>
                        <div class="localimage-controls">
                            <input type="text" class="search-input" placeholder="🔍 Search images...">
                            <select class="source-folder-select" title="Source folder">
                                <option value="">Loading...</option>
                            </select>
                            <select class="metadata-filter-select" title="Filter by metadata">
                                <option value="all">All</option>
                                <option value="with">With metadata</option>
                                <option value="without">Without metadata</option>
                            </select>
                            <select class="sort-order-select" title="Sort order">
                                <option value="name">Name (A-Z)</option>
                                <option value="date">Date (Newest)</option>
                                <option value="date_asc">Date (Oldest)</option>
                            </select>
                            <select class="fit-mode-select" title="Thumbnail fit mode">
                                <option value="crop">Crop</option>
                                <option value="pad">Pad</option>
                            </select>
                            <button class="refresh-btn" title="Refresh image list">🔄</button>
                        </div>
                        <div class="localimage-size-control">
                            <span class="size-label size-label-small">🖼️</span>
                            <input type="range" class="size-slider" min="50" max="400" value="110" title="Preview size">
                            <span class="size-label size-label-large">🖼️</span>
                            <button class="folder-manager-btn" title="Manage source folders">📁 Folder Manager</button>
                            <button class="load-image-btn" title="Load image from computer">📂 Load Image</button>
                            <input type="file" class="file-input-hidden" accept="image/*" multiple style="display: none;">
                        </div>
                        <div class="localimage-gallery">
                            <div class="localimage-gallery-viewport"></div>
                        </div>
                    </div>
                </div>
            `;
            
            // Cache all DOM elements once
            const els = state.elements;
            els.root = widgetContainer.querySelector(`#${uniqueId}`);
            els.container = widgetContainer;
            els.mainContainer = widgetContainer.querySelector(".localimage-container");
            els.gallery = widgetContainer.querySelector(".localimage-gallery");
            els.viewport = widgetContainer.querySelector(".localimage-gallery-viewport");
            els.searchInput = widgetContainer.querySelector(".search-input");
            els.selectedName = widgetContainer.querySelector(".selected-name");
            els.refreshBtn = widgetContainer.querySelector(".refresh-btn");
            els.metadataSelect = widgetContainer.querySelector(".metadata-filter-select");
            els.sortSelect = widgetContainer.querySelector(".sort-order-select");
            els.fitModeSelect = widgetContainer.querySelector(".fit-mode-select");
            els.selectedDisplay = widgetContainer.querySelector(".localimage-selected-display");
            els.controls = widgetContainer.querySelector(".localimage-controls");
            els.sizeSlider = widgetContainer.querySelector(".size-slider");
            els.sizeControl = widgetContainer.querySelector(".localimage-size-control");
            els.loadImageBtn = widgetContainer.querySelector(".load-image-btn");
            els.fileInput = widgetContainer.querySelector(".file-input-hidden");
            els.sourceSelect = widgetContainer.querySelector(".source-folder-select");
            els.folderManagerBtn = widgetContainer.querySelector(".folder-manager-btn");

            const cacheHeights = () => {
                if (els.controls) state.cachedHeights.controls = els.controls.offsetHeight;
                if (els.selectedDisplay) state.cachedHeights.selectedDisplay = els.selectedDisplay.offsetHeight;
            };

            // === CONTEXT MENU FUNCTIONS ===
            const showContextMenu = (e, imageData) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Close any existing context menu
                LocalImageGalleryNode.closeContextMenu();
                
                // Create context menu
                const menu = document.createElement('div');
                menu.className = 'localimage-context-menu';
                menu.innerHTML = `
                    <div class="localimage-context-menu-item paste-item" data-action="paste">
                        <span class="icon">📋</span>
                        <span class="label">Paste Image</span>
                    </div>
                    <div class="localimage-context-menu-item delete-item" data-action="delete">
                        <span class="icon">🗑️</span>
                        <span class="label">Delete Image</span>
                    </div>
                `;
                
                // Position menu at mouse cursor
                menu.style.left = `${e.clientX}px`;
                menu.style.top = `${e.clientY}px`;
                
                // Handle menu item clicks
                menu.addEventListener('click', async (menuEvent) => {
                    const item = menuEvent.target.closest('.localimage-context-menu-item');
                    if (!item) return;
                    
                    const action = item.dataset.action;
                    
                    if (action === 'delete') {
                        await deleteImage(imageData);
                    } else if (action === 'paste') {
                        await pasteImageFromClipboard();
                    }
                    
                    LocalImageGalleryNode.closeContextMenu();
                });
                
                // Add to document
                document.body.appendChild(menu);
                LocalImageGalleryNode._activeContextMenu = menu;
                
                // Adjust position if menu goes off-screen
                const menuRect = menu.getBoundingClientRect();
                if (menuRect.right > window.innerWidth) {
                    menu.style.left = `${window.innerWidth - menuRect.width - 5}px`;
                }
                if (menuRect.bottom > window.innerHeight) {
                    menu.style.top = `${window.innerHeight - menuRect.height - 5}px`;
                }
                
                // Close menu on click outside
                const closeOnClickOutside = (clickEvent) => {
                    if (!menu.contains(clickEvent.target)) {
                        LocalImageGalleryNode.closeContextMenu();
                        document.removeEventListener('click', closeOnClickOutside);
                        document.removeEventListener('contextmenu', closeOnClickOutside);
                    }
                };
                
                // Delay adding listeners to prevent immediate close
                setTimeout(() => {
                    document.addEventListener('click', closeOnClickOutside);
                    document.addEventListener('contextmenu', closeOnClickOutside);
                }, 0);
            };
            
            const deleteImage = async (imageData) => {
                const imageName = imageData.originalName || imageData.name;
                const imageSource = imageData.source || state.currentSourceFolder;
                
                try {
                    const response = await api.fetchApi('/imagegallery/delete_image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            image: imageName,
                            source: imageSource
                        })
                    });
                    
                    const result = await response.json();
                    
                    if (response.ok) {
                        
                        // If the deleted image was selected, clear selection
                        if (state.selectedImage === imageName) {
                            state.selectedImage = "";
                            state.selectedImageSource = "";
                            state.selectedOriginalName = "";
                            updateSelection();
                        }
                        
                        // Remove from local state
                        state.availableImages = state.availableImages.filter(
                            img => !(img.original_name === imageName && img.source === imageSource)
                        );
                        
                        // Re-render
                        state.visibleRange = { start: 0, end: 0 };
                        renderVisibleCards();
                        
                    } else {
                        console.error('Delete failed:', result.error);
                        alert(`Failed to delete image: ${result.error || 'Unknown error'}`);
                    }
                    
                } catch (error) {
                    console.error('Delete error:', error);
                    alert(`Error deleting image: ${error.message}`);
                }
            };

            const pasteImageFromClipboard = async () => {
                try {
                    if (!navigator.clipboard || !navigator.clipboard.read) {
                        alert('Clipboard API not available. Please use Ctrl+V instead.');
                        return;
                    }
                    
                    const clipboardItems = await navigator.clipboard.read();
                    let imageBlob = null;
                    
                    for (const item of clipboardItems) {
                        for (const type of item.types) {
                            if (type.startsWith('image/')) {
                                imageBlob = await item.getType(type);
                                break;
                            }
                        }
                        if (imageBlob) break;
                    }
                    
                    if (!imageBlob) {
                        alert('No image found in clipboard. Copy an image first.');
                        return;
                    }
                    
                    const originalText = els.loadImageBtn.textContent;
                    els.loadImageBtn.textContent = "⏳ Pasting...";
                    els.loadImageBtn.disabled = true;
                    
                    try {
                        const formData = new FormData();
                        formData.append('image', imageBlob, 'pasted_image.png');
                        
                        const response = await api.fetchApi('/imagegallery/paste_image', {
                            method: 'POST',
                            body: formData
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok && result.filename) {
                            // Invalidate cache first
                            await api.fetchApi("/imagegallery/invalidate_cache", { method: "POST" });
                            
                            // Reset state before fetching
                            state.currentFolder = "";
                            state.foldersRendered = false;
                            state.visibleRange = { start: 0, end: 0 };
                            
                            // Wait for fetch to complete
                            await fetchAndRender(false, false);
                            
                            // Small delay to ensure DOM is updated
                            await new Promise(resolve => setTimeout(resolve, 50));
                            
                            // Find the pasted image in refreshed list
                            const pastedImage = state.availableImages.find(img => 
                                img.original_name === result.filename || img.name.includes(result.filename)
                            );
                            
                            state.selectedImage = result.filename;
                            state.selectedOriginalName = result.filename;
                            state.selectedImageSource = pastedImage ? pastedImage.source : state.currentSourceFolder;
                            
                            updateSelection();
                            
                            // Scroll to the new image
                            setTimeout(() => {
                                const selectedCard = els.viewport.querySelector(`.localimage-image-card[data-original-name="${result.filename}"]`);
                                if (selectedCard) {
                                    selectedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }
                            }, 150);
                        } else {
                            console.error('Paste failed:', result.error || 'Unknown error');
                            alert('Failed to paste image: ' + (result.error || 'Unknown error'));
                        }
                        
                    } finally {
                        els.loadImageBtn.textContent = originalText;
                        els.loadImageBtn.disabled = false;
                    }
                    
                } catch (error) {
                    console.error('Paste error:', error);
                    
                    if (error.name === 'NotAllowedError') {
                        alert('Clipboard access denied. Please use Ctrl+V to paste, or grant clipboard permission.');
                    } else {
                        alert('Error pasting image: ' + error.message);
                    }
                }
            };

            // === API FUNCTIONS ===
            const getImages = async (page = 1, search = "", metadataFilter = "all", sortOrder = "name") => {
                state.isLoading = true;
                try {
                    const sourceEncoded = encodeURIComponent(state.currentSourceFolder || '');
                    const url = `/imagegallery/get_images?page=${page}&per_page=100&search=${encodeURIComponent(search)}&metadata=${encodeURIComponent(metadataFilter)}&sort=${encodeURIComponent(sortOrder)}&source=${sourceEncoded}`;
                    const response = await api.fetchApi(url);
                    const data = await response.json();
                    state.totalPages = data.total_pages || 1;
                    state.currentPage = data.current_page || 1;
                    return data;
                } catch (error) {
                    console.error("LocalImageGallery: Error fetching images:", error);
                    return { images: [], folders: [], total_pages: 1, current_page: 1 };
                } finally {
                    state.isLoading = false;
                }
            };

            const updateSelection = () => {
                node.setProperty("selected_image", state.selectedImage);
                node.setProperty("source_folder", state.currentSourceFolder);
                node.setProperty("actual_source", state.selectedImageSource || "");
                
                const widget = node.widgets.find(w => w.name === "selected_image");
                if (widget) widget.value = state.selectedImage;
                
                const sourceWidget = node.widgets.find(w => w.name === "source_folder");
                if (sourceWidget) sourceWidget.value = state.selectedImageSource || state.currentSourceFolder;

                let displayName = "None";
                if (state.selectedImage) {
                    displayName = state.selectedImage;
                    
                    // Add resolution if available
                    if (state.selectedImageWidth && state.selectedImageHeight) {
                        displayName += ` (${state.selectedImageWidth} × ${state.selectedImageHeight})`;
                    }
                }
                els.selectedName.textContent = displayName;
                els.selectedName.title = displayName;

                els.viewport.querySelectorAll('.localimage-image-card').forEach(card => {
                    const cardOriginalName = card.dataset.originalName;
                    const cardSource = card.dataset.imageSource;
                    
                    const isMatch = cardOriginalName === state.selectedImage && 
                                (cardSource === state.selectedImageSource || 
                                    (!cardSource && !state.selectedImageSource));
                    
                    card.classList.toggle('selected', isMatch);
                });

                LocalImageGalleryNode.setUiState(node.id, node.properties.image_gallery_unique_id, { 
                    selected_image: state.selectedImage,
                    current_source_folder: state.currentSourceFolder,
                    selected_image_source: state.selectedImageSource,
                    metadata_filter: state.metadataFilter,
                    sort_order: state.sortOrder,
                    fit_mode: state.fitMode,
                    preview_size: state.previewSize
                });
            };

            const renderFolders = (folders) => {
                const currentVal = els.folderSelect.value;
                els.folderSelect.innerHTML = `<option value="">All Folders</option><option value=".">Root Only</option>`;
                
                const fragment = document.createDocumentFragment();
                folders.forEach(folder => {
                    const option = document.createElement('option');
                    option.value = folder;
                    option.textContent = folder.replace(/\\/g, '/');
                    fragment.appendChild(option);
                });
                els.folderSelect.appendChild(fragment);
                els.folderSelect.value = currentVal;
            };

            const loadSourceFolders = async () => {
                try {
                    const response = await api.fetchApi("/imagegallery/get_source_folders");
                    const data = await response.json();
                    state.availableSourceFolders = data.folders || [];
                    renderSourceFolders();
                } catch (error) {
                    console.error("Failed to load source folders:", error);
                }
            };

            const renderSourceFolders = () => {
                const currentVal = state.currentSourceFolder;
                els.sourceSelect.innerHTML = '';
                
                const allOption = document.createElement('option');
                allOption.value = '__ALL__';
                allOption.textContent = 'All Folders';
                allOption.title = 'Show images from all configured folders';
                els.sourceSelect.appendChild(allOption);
                
                state.availableSourceFolders.forEach((folder, index) => {
                    const option = document.createElement('option');
                    option.value = folder.path;
                    option.textContent = folder.name + (folder.is_default ? ' (default)' : '');
                    option.title = folder.path;
                    els.sourceSelect.appendChild(option);
                });
                
                if (currentVal && (currentVal === '__ALL__' || state.availableSourceFolders.some(f => f.path === currentVal))) {
                    els.sourceSelect.value = currentVal;
                } else if (state.availableSourceFolders.length > 0) {
                    els.sourceSelect.value = state.availableSourceFolders[0].path;
                    state.currentSourceFolder = state.availableSourceFolders[0].path;
                }
            };

            const EMPTY_IMAGE = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgdmlld0JveD0iMCAwIDEwMCAxMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiBmaWxsPSIjMjIyIi8+CjxwYXRoIGQ9Ik0zNSA2NUw0NSA1MEw1NSA2MEw2NSA0NUw3NSA2NUgzNVoiIGZpbGw9IiM0NDQiLz4KPGNpcmNsZSBjeD0iNjUiIGN5PSIzNSIgcj0iOCIgZmlsbD0iIzQ0NCIvPgo8L3N2Zz4=';

            const updatePreviewSize = (size) => {
                state.previewSize = size;
                els.viewport.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
                
                const cardHeight = Math.round(size * 1.1);
                const imageHeight = Math.round(size * 0.9);
                state.cardHeight = cardHeight;
                
                els.viewport.style.setProperty('--card-height', `${cardHeight}px`);
                els.viewport.style.setProperty('--image-height', `${imageHeight}px`);
                
                state.visibleRange = { start: 0, end: 0 };
                renderVisibleCards();
            };

            const calculateGridMetrics = () => {
                const galleryWidth = els.gallery.clientWidth - 16;
                const minCardWidth = state.previewSize;
                const gap = 8;
                state.columnsCount = Math.max(1, Math.floor((galleryWidth + gap) / (minCardWidth + gap)));
                state.cardHeight = Math.round(state.previewSize * 1.1);
            };

            const getFilteredImages = () => {
                const nameFilter = els.searchInput.value.toLowerCase();
                return state.availableImages.filter(img => 
                    img.name.toLowerCase().includes(nameFilter)
                );
            };

            const renderVisibleCards = () => {
                const filteredImages = getFilteredImages();
                const totalImages = filteredImages.length;
                
                if (totalImages === 0) {
                    els.viewport.innerHTML = '<div class="localimage-no-images">📂 No images found<br><small>Add images to the ComfyUI/input folder</small></div>';
                    els.viewport.style.height = 'auto';
                    return;
                }

                calculateGridMetrics();
                
                const rowHeight = state.cardHeight + 8;
                const totalRows = Math.ceil(totalImages / state.columnsCount);
                const totalHeight = totalRows * rowHeight;
                
                const scrollTop = els.gallery.scrollTop;
                const viewportHeight = els.gallery.clientHeight;
                
                const buffer = 2;
                const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
                const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowHeight) + buffer);
                
                const startIndex = startRow * state.columnsCount;
                const endIndex = Math.min(totalImages, endRow * state.columnsCount);
                
                if (state.visibleRange.start === startIndex && state.visibleRange.end === endIndex) {
                    return;
                }
                
                state.visibleRange = { start: startIndex, end: endIndex }
                
                const topOffset = startRow * rowHeight;
                
                const fragment = document.createDocumentFragment();
                
                const topSpacer = document.createElement('div');
                topSpacer.className = 'localimage-spacer';
                topSpacer.style.height = `${topOffset}px`;
                topSpacer.style.gridColumn = '1 / -1';
                fragment.appendChild(topSpacer);
                
                const imageHeight = Math.round(state.previewSize * 0.9);
                
                let foundSelectedCard = false;
                
                for (let i = startIndex; i < endIndex; i++) {
                    const img = filteredImages[i];
                    const card = document.createElement("div");
                    card.className = "localimage-image-card";
                    
                    const isMatch = (state.selectedImage === img.original_name || state.selectedImage === img.name) && 
                        (!state.selectedImageSource || state.selectedImageSource === img.source || img.source === state.currentSourceFolder);
                    
                    if (isMatch) {
                        card.classList.add("selected");
                        foundSelectedCard = true;
                    }
                    
                    card.dataset.imageName = img.name;
                    card.dataset.originalName = img.original_name || img.name;
                    card.dataset.imageSource = img.source || "";
                    card.dataset.imageWidth = img.width || 0;
                    card.dataset.imageHeight = img.height || 0;
                    card.dataset.index = i;
                    card.title = img.name;
                    card.style.height = `${state.cardHeight}px`;

                    const displayName = img.name.includes('/') || img.name.includes('\\') 
                        ? img.name.split(/[/\\]/).pop() 
                        : img.name;

                    // Append fit mode so the server serves crop vs pad cache
                    let thumbSrc = img.preview_url || EMPTY_IMAGE;
                    if (img.preview_url && state.fitMode) {
                        const sep = img.preview_url.includes('?') ? '&' : '?';
                        thumbSrc = `${img.preview_url}${sep}mode=${encodeURIComponent(state.fitMode)}`;
                    }

                    card.innerHTML = `
                        <div class="localimage-media-container" style="height: ${imageHeight}px;">
                            <img src="${thumbSrc}" loading="lazy" decoding="async" alt="${displayName}">
                        </div>
                        <div class="localimage-image-card-info">
                            <p>${displayName}</p>
                        </div>
                    `;

                    const imgEl = card.querySelector("img");
                    imgEl.onerror = () => { imgEl.src = EMPTY_IMAGE; };
                    
                    fragment.appendChild(card);
                }
                 
                const bottomOffset = totalHeight - (endRow * rowHeight);
                if (bottomOffset > 0) {
                    const bottomSpacer = document.createElement('div');
                    bottomSpacer.className = 'localimage-spacer';
                    bottomSpacer.style.height = `${bottomOffset}px`;
                    bottomSpacer.style.gridColumn = '1 / -1';
                    fragment.appendChild(bottomSpacer);
                }
                
                els.viewport.innerHTML = '';
                els.viewport.appendChild(fragment);
                
            };

            // Event delegation for card clicks - TOGGLE SELECTION
            els.viewport.addEventListener("click", (e) => {
                const card = e.target.closest(".localimage-image-card");
                if (!card) return;
                
                const imageName = card.dataset.imageName;
                const imageSource = card.dataset.imageSource || "";
                const originalName = card.dataset.originalName || imageName;
                const imageWidth = card.dataset.imageWidth;
                const imageHeight = card.dataset.imageHeight;
                
                // Compare using originalName since that's what we store
                if (state.selectedImage === originalName && 
                    (!state.selectedImageSource || state.selectedImageSource === imageSource)) {
                    state.selectedImage = "";
                    state.selectedImageSource = "";
                    state.selectedOriginalName = "";
                    state.selectedImageWidth = 0;
                    state.selectedImageHeight = 0;
                } else {
                    state.selectedImage = originalName;
                    state.selectedImageSource = imageSource;
                    state.selectedOriginalName = originalName;
                    state.selectedImageWidth = imageWidth;
                    state.selectedImageHeight = imageHeight;
                }
                
                updateSelection();
            });

            // RIGHT-CLICK CONTEXT MENU
            els.viewport.addEventListener("contextmenu", (e) => {
                const card = e.target.closest(".localimage-image-card");
                if (!card) return;
                
                const imageData = {
                    name: card.dataset.imageName,
                    originalName: card.dataset.originalName || card.dataset.imageName,
                    source: card.dataset.imageSource || state.currentSourceFolder
                };
                
                showContextMenu(e, imageData);
            });

            const fetchAndRender = async (append = false, invalidateCache = false) => {
                if (state.isLoading) return;
                
                if (invalidateCache) {
                    try {
                        await api.fetchApi("/imagegallery/invalidate_cache", { method: "POST" });
                    } catch(e) {}
                }
                
                const pageToFetch = append ? state.currentPage + 1 : 1;
                if (append && pageToFetch > state.totalPages) return;
                
                if (!append) {
                    els.viewport.innerHTML = '<div class="localimage-loading">Loading images...</div>';
                    state.visibleRange = { start: 0, end: 0 };
                }
                
                const { images, folders } = await getImages(
                    pageToFetch, 
                    els.searchInput.value, 
                    state.metadataFilter, 
                    state.sortOrder
                );

                if (append) {
                    const existingNames = new Set(state.availableImages.map(i => i.name));
                    state.availableImages.push(...(images || []).filter(i => !existingNames.has(i.name)));
                } else {
                    state.availableImages = images || [];
                    els.gallery.scrollTop = 0;
                }
                
                renderVisibleCards();
                
                if (!append) cacheHeights();
            };

            const uploadImage = async (file) => {
                const formData = new FormData();
                formData.append('image', file);
                formData.append('overwrite', 'false');
                
                try {
                    const response = await api.fetchApi('/upload/image', {
                        method: 'POST',
                        body: formData
                    });
                    
                    if (response.ok) {
                        const result = await response.json();
                        let uploadedName = result.name;
                        if (result.subfolder) {
                            uploadedName = `${result.subfolder}/${result.name}`;
                        }
                        return uploadedName;
                    } else {
                        const errorText = await response.text();
                        console.error("Upload failed:", errorText);
                        return null;
                    }
                } catch (error) {
                    console.error("Upload error:", error);
                    return null;
                }
            };

            els.fileInput.addEventListener("change", async (e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                
                const originalText = els.loadImageBtn.textContent;
                els.loadImageBtn.textContent = "⏳ Uploading...";
                els.loadImageBtn.disabled = true;
                
                let lastUploadedName = null;
                
                try {
                    for (const file of files) {
                        if (!file.type.startsWith('image/')) {
                            console.warn(`Skipping non-image file: ${file.name}`);
                            continue;
                        }
                        
                        const uploadedName = await uploadImage(file);
                        if (uploadedName) {
                            lastUploadedName = uploadedName;
                        }
                    }
                    
                    if (lastUploadedName) {
                        // Invalidate cache first
                        await api.fetchApi("/imagegallery/invalidate_cache", { method: "POST" });
                        
                        // Reset state before fetching
                        state.currentFolder = "";
                        state.foldersRendered = false;
                        state.visibleRange = { start: 0, end: 0 };
                        
                        // Wait for fetch to complete
                        await fetchAndRender(false, false);
                        
                        // Small delay to ensure DOM is updated
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        state.selectedImage = lastUploadedName;
                        updateSelection();
                        
                        // Scroll to the new image
                        setTimeout(() => {
                            const selectedCard = els.viewport.querySelector(`.localimage-image-card[data-image-name="${lastUploadedName}"]`);
                            if (selectedCard) {
                                selectedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 150);
                    }
                } catch (error) {
                    console.error("Error during upload:", error);
                } finally {
                    els.loadImageBtn.textContent = originalText;
                    els.loadImageBtn.disabled = false;
                    els.fileInput.value = "";
                }
            });

            els.loadImageBtn.addEventListener("click", () => {
                els.fileInput.click();
            });

            const handlePaste = async (e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                
                let imageFile = null;
                
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        imageFile = items[i].getAsFile();
                        break;
                    }
                }
                
                if (!imageFile) {
                    return;
                }
                
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                const originalText = els.loadImageBtn.textContent;
                els.loadImageBtn.textContent = "⏳ Pasting...";
                els.loadImageBtn.disabled = true;
                
                try {
                    const formData = new FormData();
                    const blob = new Blob([await imageFile.arrayBuffer()], { type: imageFile.type || 'image/png' });
                    formData.append('image', blob, 'pasted_image.png');
                    
                    const response = await api.fetchApi('/imagegallery/paste_image', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const result = await response.json();
                    
                    if (response.ok && result.filename) {
                        // Invalidate cache first
                        await api.fetchApi("/imagegallery/invalidate_cache", { method: "POST" });
                        
                        // Reset state before fetching
                        state.currentFolder = "";
                        state.foldersRendered = false;
                        state.visibleRange = { start: 0, end: 0 };
                        
                        // Wait for fetch to complete
                        await fetchAndRender(false, false);
                        
                        // Small delay to ensure DOM is updated
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        // Find the pasted image in refreshed list
                        const pastedImage = state.availableImages.find(img => 
                            img.original_name === result.filename || img.name.includes(result.filename)
                        );
                        
                        state.selectedImage = result.filename;
                        state.selectedOriginalName = result.filename;
                        state.selectedImageSource = pastedImage ? pastedImage.source : state.currentSourceFolder;
                        
                        updateSelection();
                        
                        // Scroll to the new image
                        setTimeout(() => {
                            const selectedCard = els.viewport.querySelector(`.localimage-image-card[data-original-name="${result.filename}"]`);
                            if (selectedCard) {
                                selectedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 150);
                                            
                    } else {
                        console.error('Paste failed:', result.error || 'Unknown error');
                    }
                    
                } catch (error) {
                    console.error('Paste error:', error);
                } finally {
                    els.loadImageBtn.textContent = originalText;
                    els.loadImageBtn.disabled = false;
                }
            };

            els.container.addEventListener('paste', handlePaste, true);
            els.container.setAttribute('tabindex', '0');
            els.container.style.outline = 'none';

            els.container.addEventListener('mousedown', () => {
                els.container.focus();
            });

            let scrollRAF = null;
            let lastScrollTime = 0;
            const SCROLL_THROTTLE = 16;
            
            els.gallery.addEventListener('scroll', () => {
                const now = performance.now();
                if (now - lastScrollTime < SCROLL_THROTTLE) return;
                lastScrollTime = now;
                
                if (scrollRAF) return;
                
                scrollRAF = requestAnimationFrame(() => {
                    scrollRAF = null;
                    
                    renderVisibleCards();
                    
                    if (!state.isLoading && state.currentPage < state.totalPages) {
                        const { scrollTop, scrollHeight, clientHeight } = els.gallery;
                        if (scrollHeight - scrollTop - clientHeight < 300) {
                            fetchAndRender(true);
                        }
                    }
                });
            }, { passive: true });

            els.refreshBtn.addEventListener("click", () => {
                state.foldersRendered = false;
                fetchAndRender(false, true);
            });

            els.metadataSelect.addEventListener("change", () => {
                state.metadataFilter = els.metadataSelect.value;
                node.setProperty("metadata_filter", state.metadataFilter);
                LocalImageGalleryNode.setUiState(node.id, node.properties.image_gallery_unique_id, { 
                    metadata_filter: state.metadataFilter 
                });
                fetchAndRender(false);
            });

            els.sortSelect.addEventListener("change", () => {
                state.sortOrder = els.sortSelect.value;
                node.setProperty("sort_order", state.sortOrder);
                
                LocalImageGalleryNode.setUiState(node.id, node.properties.image_gallery_unique_id, { 
                    sort_order: state.sortOrder 
                });
                fetchAndRender(false);
            });

            els.fitModeSelect.addEventListener("change", () => {
                state.fitMode = els.fitModeSelect.value;
                node.setProperty("fit_mode", state.fitMode);
                
                // Update CSS object-fit to match mode
                if (els.root) {
                    els.root.dataset.fitMode = state.fitMode;
                }
                
                LocalImageGalleryNode.setUiState(node.id, node.properties.image_gallery_unique_id, { 
                    fit_mode: state.fitMode 
                });
                
                // Force re-render so thumbnail URLs pick up the new mode
                state.visibleRange = { start: 0, end: 0 };
                renderVisibleCards();
            });

            let sizeSliderTimeout;
            els.sizeSlider.addEventListener("input", (e) => {
                const size = parseInt(e.target.value, 10);
                updatePreviewSize(size);
                
                clearTimeout(sizeSliderTimeout);
                sizeSliderTimeout = setTimeout(() => {
                    node.setProperty("preview_size", state.previewSize);
                    
                    LocalImageGalleryNode.setUiState(node.id, node.properties.image_gallery_unique_id, { 
                        preview_size: state.previewSize 
                    });
                }, 500);
            });

            let searchTimeout;
            els.searchInput.addEventListener("input", () => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    state.visibleRange = { start: 0, end: 0 };
                    els.gallery.scrollTop = 0;
                    renderVisibleCards();
                }, 150);
            });
            
            els.searchInput.addEventListener("keydown", (e) => { 
                if (e.key === 'Enter') {
                    clearTimeout(searchTimeout);
                    fetchAndRender(false); 
                }
            });

            els.sourceSelect.addEventListener("change", () => {
                state.currentSourceFolder = els.sourceSelect.value;
                fetchAndRender(false);
            });

            els.folderManagerBtn.addEventListener("click", async () => {
                folderManager.onFoldersChanged = (folders) => {
                    state.availableSourceFolders = folders;
                    renderSourceFolders();
                };
                await folderManager.open();
            });

            let resizeRAF = null;
            
            const fitHeight = () => {
                resizeRAF = null;
                if (!els.container) return;
                
                let topOffset = els.container.offsetTop;
                
                // Fallback if DOM isn't ready
                if (topOffset < 20) {
                    topOffset = 65; 
                }

                const bottomPadding = 32; 
                
                const targetHeight = Math.max(0, node.size[1] - topOffset - bottomPadding);
                
                els.container.style.height = `${targetHeight}px`;
                els.container.style.width = "100%";
                
                calculateGridMetrics();
                state.visibleRange = { start: 0, end: 0 };
                renderVisibleCards();
            };

            this.onResize = function(size) {
                let minHeight = state.cachedHeights.selectedDisplay + state.cachedHeights.controls + HEADER_HEIGHT + MIN_GALLERY_HEIGHT;
                
                if (size[1] < minHeight) size[1] = minHeight;
                if (size[0] < MIN_NODE_WIDTH) size[0] = MIN_NODE_WIDTH;

                if (!resizeRAF) {
                    resizeRAF = requestAnimationFrame(fitHeight);
                }
            };

            this.initializeNode = async () => {    
                const existingSelectedImage = node.properties?.selected_image || "";
                const existingSourceFolder = node.properties?.source_folder || "";
                const existingActualSource = node.properties?.actual_source || "";
                
                let initialState = { 
                    selected_image: "", 
                    current_folder: "", 
                    current_source_folder: "",
                    selected_image_source: "",
                    metadata_filter: "all", 
                    sort_order: "name",
                    fit_mode: "crop",
                    preview_size: 110 
                };
                
                try {
                    const url = `/imagegallery/get_ui_state?node_id=${node.id}&gallery_id=${node.properties.image_gallery_unique_id}`;
                    const res = await api.fetchApi(url);
                    const loadedState = await res.json();
                    initialState = { ...initialState, ...loadedState };
                } catch(e) { 
                    console.error("[Gallery Debug] Failed to get initial UI state:", e); 
                }

                await loadSourceFolders();

                state.selectedImage = existingSelectedImage || initialState.selected_image || "";
                state.selectedImageSource = existingActualSource || existingSourceFolder || initialState.selected_image_source || "";
                state.currentSourceFolder = existingSourceFolder || initialState.current_source_folder || 
                    (state.availableSourceFolders.length > 0 ? state.availableSourceFolders[0].path : "");
                

                // Priority: 1. Node Properties (Paste/Save), 2. Server State (Reload), 3. Default
                state.metadataFilter = node.properties.metadata_filter || initialState.metadata_filter || "all";
                state.sortOrder = node.properties.sort_order || initialState.sort_order || "name";
                state.fitMode = node.properties.fit_mode || initialState.fit_mode || "crop";
                if (state.fitMode !== "crop" && state.fitMode !== "pad") {
                    state.fitMode = "crop";
                }

                // Handle size carefully (parse int)
                const propSize = node.properties.preview_size ? parseInt(node.properties.preview_size) : null;
                state.previewSize = propSize || initialState.preview_size || 110;
                
                if (state.currentSourceFolder) {
                    els.sourceSelect.value = state.currentSourceFolder;
                }
                
                node.setProperty("selected_image", state.selectedImage);
                node.setProperty("source_folder", state.currentSourceFolder); 
                node.setProperty("actual_source", state.selectedImageSource);
                
                const widget = node.widgets.find(w => w.name === "selected_image");
                if (widget) widget.value = state.selectedImage;
                
                const sourceWidget = node.widgets.find(w => w.name === "source_folder"); 
                if (sourceWidget) sourceWidget.value = state.selectedImageSource || state.currentSourceFolder; 

                let displayName = "None";
                if (state.selectedImage) {
                    displayName = state.selectedImage;
                }
                els.selectedName.textContent = displayName;
                els.selectedName.title = displayName;
                
                els.sizeSlider.value = state.previewSize;
                updatePreviewSize(state.previewSize);

                if (els.fitModeSelect) {
                    els.fitModeSelect.value = state.fitMode;
                }
                if (els.root) {
                    els.root.dataset.fitMode = state.fitMode;
                }

                await fetchAndRender();

                // === RESTORE RESOLUTION FOR SELECTED IMAGE ===
                if (state.selectedImage) {
                    const filteredImages = getFilteredImages();
                    const selectedImgData = filteredImages.find(img => 
                        img.original_name === state.selectedImage
                    );
                    
                    if (selectedImgData) {
                        state.selectedImageWidth = selectedImgData.width || 0;
                        state.selectedImageHeight = selectedImgData.height || 0;
                        
                        // Update display with resolution
                        let displayName = state.selectedImage;
                        if (state.selectedImageWidth && state.selectedImageHeight) {
                            displayName += ` (${state.selectedImageWidth} × ${state.selectedImageHeight})`;
                        }
                        els.selectedName.textContent = displayName;
                        els.selectedName.title = displayName;
                    }
                }

                // === SCROLL TO SELECTED IMAGE ===
                if (state.selectedImage) {
                    const filteredImages = getFilteredImages();
                    const selectedIndex = filteredImages.findIndex(img => 
                        img.original_name === state.selectedImage
                    );
                    
                    if (selectedIndex >= 0) {
                        calculateGridMetrics();
                        const row = Math.floor(selectedIndex / state.columnsCount);
                        const rowHeight = state.cardHeight + 8;
                        const targetScrollTop = Math.max(0, (row * rowHeight) - (els.gallery.clientHeight / 2) + (rowHeight / 2));

                        
                        setTimeout(() => {
                            els.gallery.scrollTop = targetScrollTop;
                            state.visibleRange = { start: 0, end: 0 };
                            renderVisibleCards();
                            
                        }, 100);
                    } else {
                        console.log(`[Gallery Debug] WARNING: Selected image not found in list!`);
                    }
                }
                
                if (state.currentFolder && els.folderSelect?.querySelector(`option[value="${state.currentFolder}"]`)) {
                    els.folderSelect.value = state.currentFolder;
                }
                
                if (state.metadataFilter) {
                    els.metadataSelect.value = state.metadataFilter;
                }
                
                if (state.sortOrder) {
                    els.sortSelect.value = state.sortOrder;
                }
                
                if (state.fitMode && els.fitModeSelect) {
                    els.fitModeSelect.value = state.fitMode;
                    if (els.root) {
                        els.root.dataset.fitMode = state.fitMode;
                    }
                }
                
            };


            const originalOnRemoved = this.onRemoved;
            this.onRemoved = function() {
                if (scrollRAF) cancelAnimationFrame(scrollRAF);
                if (resizeRAF) cancelAnimationFrame(resizeRAF);
                clearTimeout(searchTimeout);
                clearTimeout(sizeSliderTimeout);
                
                if (els.container) {
                    els.container.removeEventListener('paste', handlePaste, true);
                }
                
                // Close context menu if this node is removed
                LocalImageGalleryNode.closeContextMenu();
                
                state.elements = {};
                state.availableImages = [];
                
                if (originalOnRemoved) originalOnRemoved.apply(this, arguments);
            };

            requestAnimationFrame(async () => {
                await this.initializeNode();
                fitHeight();
            });

            return result;
        };

        // Global styles - only inject once
        nodeType.prototype._ensureGlobalStyles = function() {
            if (document.getElementById('localimage-gallery-styles')) return;
            
            const style = document.createElement('style');
            style.id = 'localimage-gallery-styles';
            style.textContent = `
                /* Context Menu Styles */
                .localimage-context-menu {
                    position: fixed;
                    z-index: 100000;
                    background: #252525;
                    border: 1px solid #444;
                    border-radius: 6px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    min-width: 160px;
                    padding: 4px 0;
                    font-family: sans-serif;
                    font-size: 14px;
                }
                .localimage-context-menu-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px 16px;
                    cursor: pointer;
                    color: #ddd;
                    transition: background 0.15s;
                }
                .localimage-context-menu-item:hover {
                    background: #3a3a3a;
                }
                .localimage-context-menu-item.delete-item:hover {
                    background: #5a2a2a;
                    color: #ff6b6b;
                }
                .localimage-context-menu-item .icon {
                    font-size: 16px;
                    width: 20px;
                    text-align: center;
                }
                .localimage-context-menu-item .label {
                    flex-grow: 1;
                }
                .localimage-context-menu-separator {
                    height: 1px;
                    background: #444;
                    margin: 4px 8px;
                }
                
                /* Existing styles */
                .localimage-root .localimage-size-control .folder-manager-btn {
                    background: #3a3a5a;
                    color: #fff;
                    border: none;
                    border-radius: 4px;
                    padding: 6px 12px;
                    cursor: pointer;
                    font-size: 14px;
                    flex-shrink: 0;
                    white-space: nowrap;
                    transition: background 0.2s;
                }
                .localimage-root .localimage-size-control .folder-manager-btn:hover {
                    background: #4a4a7a;
                }
                .localimage-root .localimage-container { 
                    display: flex; flex-direction: column; height: 100%; 
                    font-family: sans-serif; overflow: hidden; 
                    background-color: #1e1e1e; border-radius: 4px;
                    contain: layout style;
                }
                .localimage-root .localimage-selected-display { 
                    padding: 12px 10px; background-color: #252525; 
                    border-bottom: 1px solid #3a3a3a; flex-shrink: 0; 
                    display: flex; align-items: center; gap: 8px;
                }
                .localimage-root .localimage-selected-display .label { font-size: 15px; color: #888; }
                .localimage-root .localimage-selected-display .selected-name { 
                    color: #00FFC9; font-weight: bold; font-size: 15px; flex-grow: 1;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                .localimage-root .localimage-selected-display .paste-hint {
                    font-size: 11px;
                    color: #666;
                    margin-left: auto;
                    padding: 2px 8px;
                    background: #2a2a2a;
                    border-radius: 4px;
                    border: 1px solid #3a3a3a;
                    cursor: help;
                }
                .localimage-root .localimage-container:focus-within .paste-hint {
                    color: #00FFC9;
                    border-color: #00FFC9;
                }
                .localimage-root .localimage-controls { 
                    display: flex; padding: 8px; gap: 8px; align-items: center; 
                    flex-shrink: 0; background-color: #252525;
                    border-bottom: 1px solid #3a3a3a; flex-wrap: wrap;
                }
                .localimage-root .localimage-controls input[type=text] { 
                    flex-grow: 1; min-width: 100px; background: #333; color: #ccc; 
                    border: 1px solid #555; padding: 12px 10px; border-radius: 4px; font-size: 15px;
                }
                .localimage-root .localimage-controls input[type=text]:focus { outline: none; border-color: #00FFC9; }
                .localimage-root .localimage-controls select {
                    background: #333;
                    color: #ccc;
                    border: 1px solid #555;
                    padding: 12px 12px;
                    border-radius: 4px;
                    font-size: 15px;
                    width: 200px;
                    min-width: 200px;
                    max-width: 200px;
                }
                .localimage-root .localimage-controls button {
                    background: #444; color: #fff; border: none; border-radius: 4px;
                    padding: 6px 6px; cursor: pointer; font-size: 24px; flex-shrink: 0;
                }
                .localimage-root .localimage-controls button:hover { background: #555; }
                
                /* Size control slider styles */
                .localimage-root .localimage-size-control {
                    display: flex; align-items: center; gap: 8px;
                    padding: 8px 10px; background-color: #252525;
                    border-bottom: 1px solid #3a3a3a; flex-shrink: 0;
                }
                .localimage-root .localimage-size-control .size-label {
                    flex-shrink: 0; line-height: 1;
                }
                .localimage-root .localimage-size-control .size-label-small {
                    font-size: 15px;
                }
                .localimage-root .localimage-size-control .size-label-large {
                    font-size: 20px;
                }
                .localimage-root .localimage-size-control .size-slider {
                    flex-grow: 1; height: 8px; -webkit-appearance: none; appearance: none;
                    background: #444; border-radius: 2px; outline: none; cursor: pointer;
                }
                .localimage-root .localimage-size-control .size-slider::-webkit-slider-thumb {
                    -webkit-appearance: none; appearance: none; width: 24px; height: 24px;
                    background: #00A68C; border-radius: 50%; cursor: pointer;
                    transition: background 0.2s;
                }

                .localimage-root .localimage-size-control .size-slider::-webkit-slider-thumb:hover {
                    background: #008C74;
                }

                .localimage-root .localimage-size-control .size-slider::-moz-range-thumb {
                    width: 14px; height: 14px; background: #00FFC9; border-radius: 50%;
                    cursor: pointer; border: none;
                }
                
                /* Load image button styles */
                .localimage-root .localimage-size-control .load-image-btn {
                    background: #2a6a4a; color: #fff; border: none; border-radius: 4px;
                    padding: 6px 12px; cursor: pointer; font-size: 14px; flex-shrink: 0;
                    white-space: nowrap; transition: background 0.2s;
                }
                .localimage-root .localimage-size-control .load-image-btn:hover {
                    background: #3a8a5a;
                }
                .localimage-root .localimage-size-control .load-image-btn:disabled {
                    background: #555; cursor: not-allowed; opacity: 0.7;
                }
                
                .localimage-root .localimage-gallery { 
                    flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; 
                    background-color: #1a1a1a;
                    contain: strict;
                }
                .localimage-root .localimage-gallery-viewport {
                    padding: 8px; 
                    display: grid; 
                    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); 
                    gap: 8px; 
                    align-content: start;
                }
                .localimage-root .localimage-spacer {
                    pointer-events: none;
                }
                .localimage-root .localimage-image-card { 
                    cursor: pointer; border: 4px solid transparent; border-radius: 6px; 
                    background-color: #2a2a2a; display: flex; flex-direction: column; 
                    position: relative; overflow: hidden;
                    contain: layout style paint;
                    transition: border-color 0.2s;
                }
                .localimage-root .localimage-image-card:hover { 
                    border-color: #555;
                }
                .localimage-root .localimage-image-card.selected { 
                    border-color: #00FFC9; box-shadow: 0 0 10px rgba(0, 255, 201, 0.3); 
                }
                .localimage-root .localimage-media-container { 
                    width: 100%; background-color: #000; 
                    overflow: hidden; display: flex; align-items: center; 
                    justify-content: center; flex-shrink: 0;
                }
                .localimage-root .localimage-media-container img { 
                    width: 100%; height: 100%; object-fit: cover;
                }
                /* Pad mode: show full image (thumbnails are already letterboxed with black) */
                .localimage-root[data-fit-mode="pad"] .localimage-media-container img {
                    object-fit: contain;
                }
                .localimage-root[data-fit-mode="crop"] .localimage-media-container img {
                    object-fit: cover;
                }
                .localimage-root .localimage-image-card-info { 
                    padding: 4px 6px; background: #2a2a2a; flex-grow: 1;
                    display: flex; align-items: center; justify-content: center;
                }
                .localimage-root .localimage-image-card p { 
                    font-size: 12px; margin: 0; word-break: break-word; text-align: center; 
                    color: #aaa; line-height: 1.2; max-height: 26px; overflow: hidden;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                }
                .localimage-root .localimage-gallery::-webkit-scrollbar { width: 16px; }
                .localimage-root .localimage-gallery::-webkit-scrollbar-track { background: #2a2a2a; border-radius: 4px; }
                .localimage-root .localimage-gallery::-webkit-scrollbar-thumb { background-color: #555; border-radius: 4px; }
                .localimage-root .localimage-gallery::-webkit-scrollbar-thumb:hover { background-color: #777; }
                .localimage-root .localimage-loading, .localimage-root .localimage-no-images {
                    grid-column: 1 / -1; text-align: center; padding: 20px; color: #666; font-size: 14px;
                }
            `;
            document.head.appendChild(style);
        };
    }
};

app.registerExtension({
    name: "LocalImageGallery.GalleryUI",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "LocalImageGallery") {
            LocalImageGalleryNode.setup(nodeType, nodeData);
        }
    },
});
