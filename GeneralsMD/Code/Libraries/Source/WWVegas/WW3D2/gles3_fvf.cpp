/*
** GeneralsX Web Port — FVF (Flexible Vertex Format) Decoder Implementation
**
** Decodes DX8's Flexible Vertex Format bitmask into byte offsets,
** then translates those offsets to glVertexAttribPointer() calls.
**
** VERTEX DATA LAYOUT (DX8 specification, strict order):
**   [Position 3f] [BlendWeights 1-4f] [Normal 3f] [Diffuse 4ub] [Specular 4ub] [TexCoord0 2-4f] [TexCoord1 2-4f] ...
**
** DIFFUSE/SPECULAR COLOR HANDLING:
**   DX8 stores vertex colors as DWORD in BGRA byte order (B=byte0, G=byte1, R=byte2, A=byte3).
**   We pass them as GL_UNSIGNED_BYTE with GL_TRUE normalization, which maps 0-255 → 0.0-1.0.
**   The BGRA→RGBA swizzle is handled by using GL_BGRA_EXT format where available,
**   or by shader swizzle on platforms that don't support it.
**   WebGL2 NOTE: GL_BGRA is NOT a valid format. We handle the swizzle in the shader instead.
**
** LICENSE: GPL-3.0
*/

#if defined(__EMSCRIPTEN__)

#include "gles3_fvf.h"
#include <cstring>
#include <cstdio>

// ============================================================================
// Get_FVF_Vertex_Size — Calculate total vertex size from FVF flags
// Mirrors D3DXGetFVFVertexSize() from the DX8 SDK
// ============================================================================
unsigned int GLES3_FVFDecoder::Get_FVF_Vertex_Size(unsigned int fvf) {
    unsigned int size = 0;

    // Position
    switch (fvf & D3DFVF_POSITION_MASK) {
        case D3DFVF_XYZ:    size += 3 * sizeof(float); break;    // 12 bytes
        case D3DFVF_XYZRHW: size += 4 * sizeof(float); break;    // 16 bytes (pre-transformed)
        case D3DFVF_XYZB1:  size += 4 * sizeof(float); break;    // 16 bytes (XYZ + 1 blend)
        case D3DFVF_XYZB2:  size += 5 * sizeof(float); break;    // 20 bytes
        case D3DFVF_XYZB3:  size += 6 * sizeof(float); break;    // 24 bytes
        case D3DFVF_XYZB4:
            if (fvf & D3DFVF_LASTBETA_UBYTE4)
                size += 6 * sizeof(float) + sizeof(unsigned int); // 3 blend floats + 1 DWORD index
            else
                size += 7 * sizeof(float); // 28 bytes
            break;
        case D3DFVF_XYZB5:  size += 8 * sizeof(float); break;
    }

    // Normal
    if (fvf & D3DFVF_NORMAL)
        size += 3 * sizeof(float);  // 12 bytes

    // Diffuse color
    if (fvf & D3DFVF_DIFFUSE)
        size += sizeof(unsigned int);  // 4 bytes (BGRA packed)

    // Specular color
    if (fvf & D3DFVF_SPECULAR)
        size += sizeof(unsigned int);  // 4 bytes (BGRA packed)

    // Texture coordinates
    unsigned int tex_count = Get_Tex_Count(fvf);
    for (unsigned int i = 0; i < tex_count; i++) {
        size += Get_Tex_Coord_Size(fvf, i) * sizeof(float);
    }

    return size;
}

// ============================================================================
// Get_Tex_Count — Extract texture coordinate count from FVF
// ============================================================================
unsigned int GLES3_FVFDecoder::Get_Tex_Count(unsigned int fvf) {
    return (fvf & D3DFVF_TEXCOUNT_MASK) >> D3DFVF_TEXCOUNT_SHIFT;
}

// ============================================================================
// Get_Tex_Coord_Size — Get dimension (1-4 floats) of a texture coord set
// Bits 16-31 encode the sizes: 2 bits per set
//   00 = 2 floats (default, UV)
//   01 = 3 floats (UVW)
//   10 = 4 floats (UVWQ)
//   11 = 1 float  (U only)
// ============================================================================
unsigned int GLES3_FVFDecoder::Get_Tex_Coord_Size(unsigned int fvf,
                                                    unsigned int index) {
    unsigned int bits = (fvf >> (index * 2 + 16)) & 0x3;
    switch (bits) {
        case D3DFVF_TEXTUREFORMAT1: return 1;   // 1D
        case D3DFVF_TEXTUREFORMAT2: return 2;   // 2D (default)
        case D3DFVF_TEXTUREFORMAT3: return 3;   // 3D
        case D3DFVF_TEXTUREFORMAT4: return 4;   // 4D
        default: return 2;
    }
}

// ============================================================================
// Decode — Parse FVF bitmask and compute byte offsets for each component
// Mirrors the FVFInfoClass constructor from the original dx8fvf.cpp
// ============================================================================
void GLES3_FVFDecoder::Decode(unsigned int new_fvf) {
    fvf = new_fvf;
    fvf_size = Get_FVF_Vertex_Size(fvf);

    unsigned int offset = 0;

    // --- Position ---
    location_offset = offset;
    switch (fvf & D3DFVF_POSITION_MASK) {
        case D3DFVF_XYZ:    offset += 3 * sizeof(float); break;
        case D3DFVF_XYZRHW: offset += 4 * sizeof(float); break;
        case D3DFVF_XYZB1:  offset += 4 * sizeof(float); break;
        case D3DFVF_XYZB2:  offset += 5 * sizeof(float); break;
        case D3DFVF_XYZB3:  offset += 6 * sizeof(float); break;
        case D3DFVF_XYZB4:
            if (fvf & D3DFVF_LASTBETA_UBYTE4)
                offset += 6 * sizeof(float) + sizeof(unsigned int);
            else
                offset += 7 * sizeof(float);
            break;
        case D3DFVF_XYZB5:  offset += 8 * sizeof(float); break;
    }
    blend_offset = location_offset + 3 * sizeof(float);  // blend starts after XYZ

    // --- Normal ---
    normal_offset = offset;
    if (fvf & D3DFVF_NORMAL)
        offset += 3 * sizeof(float);

    // --- Diffuse color ---
    diffuse_offset = offset;
    if (fvf & D3DFVF_DIFFUSE)
        offset += sizeof(unsigned int);

    // --- Specular color ---
    specular_offset = offset;
    if (fvf & D3DFVF_SPECULAR)
        offset += sizeof(unsigned int);

    // --- Texture coordinates ---
    unsigned int tex_count = Get_Tex_Count(fvf);
    for (unsigned int i = 0; i < D3DDP_MAXTEXCOORD; i++) {
        texcoord_offset[i] = offset;
        if (i < tex_count) {
            offset += Get_Tex_Coord_Size(fvf, i) * sizeof(float);
        }
    }
}

// ============================================================================
// Get_Tex_Offset — Get byte offset of texture coordinate set N
// ============================================================================
unsigned int GLES3_FVFDecoder::Get_Tex_Offset(unsigned int n) const {
    if (n >= D3DDP_MAXTEXCOORD) return 0;
    return texcoord_offset[n];
}

namespace {
const int kCachedAttribs = 7;                     // ATTR_POSITION .. ATTR_TEXCOORD3
unsigned g_attribEnabled = 0;                     // bit per attribute
float g_attribConst[kCachedAttribs][4];

void Attrib_Enable(int i, bool on) {
    const unsigned bit = 1u << i;
    if (((g_attribEnabled & bit) != 0) == on) return;
    if (on) { glEnableVertexAttribArray(i); g_attribEnabled |= bit; }
    else    { glDisableVertexAttribArray(i); g_attribEnabled &= ~bit; }
}

void Attrib_Const(int i, float x, float y, float z, float w) {
    float *c = g_attribConst[i];
    if (c[0] == x && c[1] == y && c[2] == z && c[3] == w) return;
    glVertexAttrib4f(i, x, y, z, w);
    c[0] = x; c[1] = y; c[2] = z; c[3] = w;
}
} // namespace

void GLES3_FVF_Reset_Attrib_Cache() { GLES3_FVFDecoder::Reset_Attrib_Cache(); }

void GLES3_FVFDecoder::Reset_Attrib_Cache() {
    g_attribEnabled = 0;
    for (int i = 0; i < kCachedAttribs; i++) {
        g_attribConst[i][0] = g_attribConst[i][1] = g_attribConst[i][2] = 0.0f;
        g_attribConst[i][3] = 1.0f;
    }
}

// ============================================================================
// Apply_Vertex_Attribs — Set up glVertexAttribPointer for decoded FVF
//
// This is the core bridge between DX8's FVF system and OpenGL ES 3.0's
// explicit vertex attribute specification.
//
// Must be called while the correct VBO is bound to GL_ARRAY_BUFFER.
// The 'stride' parameter is the vertex size in bytes (should match fvf_size).
// ============================================================================
void GLES3_FVFDecoder::Apply_Vertex_Attribs(unsigned int stride,
                                             unsigned int base_offset_bytes) const {
    if (stride == 0) stride = fvf_size;

    // --- Position (always present) ---
    if (fvf & D3DFVF_POSITION_MASK) {
        bool is_xyzrhw = (fvf & D3DFVF_POSITION_MASK) == D3DFVF_XYZRHW;
        int pos_components = is_xyzrhw ? 4 : 3;

        Attrib_Enable(ATTR_POSITION, true);
        glVertexAttribPointer(
            ATTR_POSITION,
            pos_components,
            GL_FLOAT,
            GL_FALSE,
            stride,
            (const void*)(uintptr_t)(base_offset_bytes + location_offset)
        );
    } else {
        Attrib_Enable(ATTR_POSITION, false);
    }

    // --- Normal ---
    if (fvf & D3DFVF_NORMAL) {
        Attrib_Enable(ATTR_NORMAL, true);
        glVertexAttribPointer(
            ATTR_NORMAL,
            3,
            GL_FLOAT,
            GL_FALSE,
            stride,
            (const void*)(uintptr_t)(base_offset_bytes + normal_offset)
        );
    } else {
        Attrib_Enable(ATTR_NORMAL, false);
        // Default normal (0, 0, 1) for vertices without normals
        Attrib_Const(ATTR_NORMAL, 0.0f, 0.0f, 1.0f, 1.0f);
    }

    // --- Diffuse color ---
    // DX8 stores as BGRA packed DWORD. In the shader, we'll swizzle B↔R.
    // GL_UNSIGNED_BYTE with GL_TRUE normalization maps 0-255 → 0.0-1.0.
    // WebGL2 does NOT support GL_BGRA, so we pass as GL_RGBA and swizzle
    // in the vertex shader (swap .r and .b).
    if (fvf & D3DFVF_DIFFUSE) {
        Attrib_Enable(ATTR_COLOR, true);
        glVertexAttribPointer(
            ATTR_COLOR,
            4,
            GL_UNSIGNED_BYTE,
            GL_TRUE,    // normalize 0-255 → 0.0-1.0
            stride,
            (const void*)(uintptr_t)(base_offset_bytes + diffuse_offset)
        );
    } else {
        Attrib_Enable(ATTR_COLOR, false);
        // Default: opaque white (matches DX8 default when no vertex color)
        Attrib_Const(ATTR_COLOR, 1.0f, 1.0f, 1.0f, 1.0f);
    }

    // --- Texture coordinates ---
    unsigned int tex_count = Get_Tex_Count(fvf);
    for (unsigned int i = 0; i < 4; i++) {  // shader supports up to 4
        int attr_loc = ATTR_TEXCOORD0 + i;
        if (i < tex_count) {
            unsigned int dim = Get_Tex_Coord_Size(fvf, i);
            Attrib_Enable(attr_loc, true);
            glVertexAttribPointer(
                attr_loc,
                dim,
                GL_FLOAT,
                GL_FALSE,
                stride,
                (const void*)(uintptr_t)(base_offset_bytes + texcoord_offset[i])
            );
        } else {
            Attrib_Enable(attr_loc, false);
            Attrib_Const(attr_loc, 0.0f, 0.0f, 0.0f, 1.0f);   // what glVertexAttrib2f(0, 0) set
        }
    }
}

// ============================================================================
// Disable_All_Attribs — Disable all vertex attribute arrays
// ============================================================================
void GLES3_FVFDecoder::Disable_All_Attribs() {
    for (int i = 0; i <= ATTR_TEXCOORD3; i++) {
        Attrib_Enable(i, false);
    }
}

#endif // __EMSCRIPTEN__
