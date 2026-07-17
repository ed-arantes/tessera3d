/**
 * Posterized OBJ + STL Exporter
 * OBJ: Wavefront format with vertex colors, for BambuStudio import.
 * STL: Binary format (single merged mesh), universally compatible with all slicers.
 */

const Exporter3MF = {

  /**
   * Build and download OBJ file with vertex colors.
   * Uses array-join instead of string concatenation for large meshes (10-100x faster).
   * layersData[i]: { name, hex, vertices: Float32Array, triangles: Uint32Array }
   */
  async export(layersData, onProgress) {
    const baseName = 'posterized_model';
    const totalLayers = Math.max(1, layersData.length);
    let processedLayers = 0;

    if (typeof onProgress === 'function') {
      onProgress(0, 'Starting OBJ packaging...');
    }

    // Use an array of strings and join once at the end - much faster than +=
    const lines = ['# Posterized multicolor model\n'];
    let vertexOffset = 0;

    for (const layer of layersData) {
      const verts = layer.vertices;   // Float32Array, flat [x,y,z, ...]
      const tris  = layer.triangles;  // Uint32Array,  flat [v1,v2,v3, ...]
      const vertCount = verts.length / 3;

      const { r, g, b } = this._hexToRgb01(layer.hex || '#ffffff');
      const rStr = r.toFixed(6);
      const gStr = g.toFixed(6);
      const bStr = b.toFixed(6);

      lines.push(`o ${this._sanitizeName(layer.name)}\n`);

      // Vertices with appended RGB colors (v x y z r g b)
      for (let j = 0; j < verts.length; j += 3) {
        lines.push(`v ${verts[j].toFixed(4)} ${verts[j+1].toFixed(4)} ${verts[j+2].toFixed(4)} ${rStr} ${gStr} ${bStr}\n`);
      }

      // Faces (1-based, offset by previously written vertices)
      for (let j = 0; j < tris.length; j += 3) {
        const a = tris[j]   + 1 + vertexOffset;
        const b = tris[j+1] + 1 + vertexOffset;
        const c = tris[j+2] + 1 + vertexOffset;
        lines.push(`f ${a} ${b} ${c}\n`);
      }

      lines.push('\n');
      vertexOffset += vertCount;
      processedLayers++;

      if (typeof onProgress === 'function') {
        onProgress((processedLayers / totalLayers) * 100, `Writing OBJ data ${processedLayers}/${totalLayers}...`);
      }

      await this._yieldToUI();
    }

    if (typeof onProgress === 'function') {
      onProgress(100, 'Starting download...');
    }
    try {
        this._download(lines.join(''), baseName + '.obj', 'text/plain');
    } catch (e) {
        console.error("OBJ Download failed:", e);
        if (typeof onProgress === 'function') onProgress(100, `Error during download: ${e.message}`);
    }
  },

  /**
   * Build and download a binary STL (merged all meshes into one shell).
   * Binary STL: 80-byte header + 4-byte triangle count + 50 bytes per triangle.
   * meshes[i]: { vertices: Float32Array, triangles: Uint32Array }
   */
  async exportSTL(meshes, onProgress) {
    if (typeof onProgress === 'function') onProgress(0, 'Counting triangles...');

    // Count total triangles across all meshes
    let totalTris = 0;
    for (const m of meshes) totalTris += m.triangles.length / 3;

    // Binary STL layout: 80-byte header + 4-byte uint32 count + 50 bytes * numTris
    const bufferSize = 84 + totalTris * 50;
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // Write header (80 bytes ASCII, zero-padded)
    const header = 'Binary STL - Antigravity Forge';
    for (let i = 0; i < 80; i++) {
      view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
    }

    // Write triangle count
    view.setUint32(80, totalTris, true);

    let offset = 84;
    let writtenTris = 0;
    let meshIndex = 0;

    for (const mesh of meshes) {
      const verts = mesh.vertices;   // Float32Array [x,y,z per vertex]
      const tris  = mesh.triangles;  // Uint32Array  [v1,v2,v3 per tri]
      const numTris = tris.length / 3;

      for (let t = 0; t < numTris; t++) {
        const i0 = tris[t * 3]     * 3;
        const i1 = tris[t * 3 + 1] * 3;
        const i2 = tris[t * 3 + 2] * 3;

        // Compute face normal via cross product
        const ax = verts[i1]     - verts[i0];
        const ay = verts[i1 + 1] - verts[i0 + 1];
        const az = verts[i1 + 2] - verts[i0 + 2];
        const bx = verts[i2]     - verts[i0];
        const by = verts[i2 + 1] - verts[i0 + 1];
        const bz = verts[i2 + 2] - verts[i0 + 2];

        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

        // Normal (12 bytes)
        view.setFloat32(offset,      nx / len, true); offset += 4;
        view.setFloat32(offset,      ny / len, true); offset += 4;
        view.setFloat32(offset,      nz / len, true); offset += 4;

        // Vertex 1 (12 bytes)
        view.setFloat32(offset, verts[i0],     true); offset += 4;
        view.setFloat32(offset, verts[i0 + 1], true); offset += 4;
        view.setFloat32(offset, verts[i0 + 2], true); offset += 4;

        // Vertex 2 (12 bytes)
        view.setFloat32(offset, verts[i1],     true); offset += 4;
        view.setFloat32(offset, verts[i1 + 1], true); offset += 4;
        view.setFloat32(offset, verts[i1 + 2], true); offset += 4;

        // Vertex 3 (12 bytes)
        view.setFloat32(offset, verts[i2],     true); offset += 4;
        view.setFloat32(offset, verts[i2 + 1], true); offset += 4;
        view.setFloat32(offset, verts[i2 + 2], true); offset += 4;

        // Attribute byte count (2 bytes, always 0)
        view.setUint16(offset, 0, true); offset += 2;

        writtenTris++;
      }

      meshIndex++;
      if (typeof onProgress === 'function') {
        onProgress((meshIndex / meshes.length) * 100, `Writing STL mesh ${meshIndex}/${meshes.length}...`);
      }
      await this._yieldToUI();
    }

    if (typeof onProgress === 'function') onProgress(100, 'Starting download...');
    try {
        this._downloadBinary(buffer, 'model.stl', 'application/octet-stream');
    } catch (e) {
        console.error("STL Download failed:", e);
        if (typeof onProgress === 'function') onProgress(100, `Error during download: ${e.message}`);
    }
  },

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _hexToRgb01(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 8) hex = hex.slice(0, 6);
    const n = parseInt(hex, 16);
    return {
      r: ((n >> 16) & 0xff) / 255,
      g: ((n >>  8) & 0xff) / 255,
      b: ( n        & 0xff) / 255
    };
  },

  _sanitizeName(name) {
    return name.replace(/\s+/g, '_');
  },

  _yieldToUI() {
    return new Promise(resolve => {
      requestAnimationFrame(() => resolve());
    });
  },

  /**
   * Downloads text content (OBJ).
   */
  _download(text, filename, mime) {
    try {
        const blob = new Blob([text], { type: mime });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Error during text download:", e);
        throw new Error("Failed to initiate file download.");
    }
  },

  /**
   * Downloads binary content (STL).
   */
  _downloadBinary(buffer, filename, mime) {
    try {
        const blob = new Blob([buffer], { type: mime });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Error during binary download:", e);
        throw new Error("Failed to initiate file download.");
    }
  }
};

window.Exporter3MF = Exporter3MF;