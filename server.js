const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Create directories if they don't exist
const profilesDir = path.join(__dirname, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

const imagesDir = path.join(__dirname, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Static route to serve uploaded images
app.use("/images", express.static(path.join(__dirname, "public", "images")));

const upload = multer({ dest: "uploads/" });

// 🚀 OPTIMIZATION: Add gallery caching
let galleryCache = null;
let galleryCacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes cache

// 🚀 OPTIMIZATION: Add response compression
app.use(require('compression')());

app.use(cors());
app.use(bodyParser.json());

// 🔐 Helper function to sanitize gallery data
function sanitizeGalleryData(profiles) {
    return profiles.map(profile => ({
        CharacterId: generateSafeId(profile.CharacterName, profile.CharacterId),
        CharacterName: profile.CharacterName,
        Server: "Gallery", // Generic server name
        ProfileImageUrl: profile.ProfileImageUrl,
        Tags: profile.Tags,
        Bio: profile.Bio,
        GalleryStatus: profile.GalleryStatus,
        Race: profile.Race,
        Pronouns: profile.Pronouns,
        Links: profile.Links,
        LikeCount: profile.LikeCount,
        LastUpdated: profile.LastUpdated,
        ImageZoom: profile.ImageZoom,
        ImageOffset: profile.ImageOffset
    }));
}

// 🛡️ Helper function to remove sensitive data from profile responses
function sanitizeProfileResponse(profile) {
    const sanitized = { ...profile };
    
    // Remove local file paths that could expose real usernames
    delete sanitized.CustomImagePath;
    
    return sanitized;
}

// 🔐 Generate safe ID for public view
function generateSafeId(characterName, originalId) {
    return characterName.toLowerCase().replace(/\s+/g, '_') + '_' + 
           crypto.createHash('md5').update(originalId).digest('hex').substring(0, 8);
}

// 🚀 NEW: Health check endpoint for connection testing
app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "healthy", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// 🛡️ FIXED: Robust async file operations with error handling
const readProfileAsync = (filePath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }
            
            // Check if file is empty or only whitespace
            if (!data || data.trim().length === 0) {
                console.error(`[Error] Empty profile file: ${filePath}`);
                reject(new Error(`Profile file is empty: ${filePath}`));
                return;
            }
            
            try {
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseError) {
                console.error(`[Error] Invalid JSON in file ${filePath}:`, parseError.message);
                console.error(`[Error] File content preview:`, data.substring(0, 100));
                
                // Try to recover by deleting the corrupted file
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr) {
                        console.error(`[Error] Failed to delete corrupted file ${filePath}:`, unlinkErr.message);
                    } else {
                        console.log(`[Recovery] Deleted corrupted file: ${filePath}`);
                    }
                });
                
                reject(new Error(`Invalid JSON in profile file: ${filePath}`));
            }
        });
    });
};

const writeProfileAsync = (filePath, data) => {
    return new Promise((resolve, reject) => {
        // First, validate that the data can be stringified
        let jsonString;
        try {
            jsonString = JSON.stringify(data, null, 2);
        } catch (stringifyError) {
            console.error(`[Error] Cannot stringify data for ${filePath}:`, stringifyError.message);
            reject(stringifyError);
            return;
        }
        
        // For files with spaces, just write directly instead of atomic rename
        if (filePath.includes(' ')) {
            fs.writeFile(filePath, jsonString, 'utf-8', (writeErr) => {
                if (writeErr) {
                    reject(writeErr);
                    return;
                }
                resolve();
            });
            return;
        }
        
        // For files without spaces, use atomic rename (safer)
        const tempPath = filePath + '.tmp';
        
        fs.writeFile(tempPath, jsonString, 'utf-8', (writeErr) => {
            if (writeErr) {
                reject(writeErr);
                return;
            }
            
            // Atomically rename temp file to final file
            fs.rename(tempPath, filePath, (renameErr) => {
                if (renameErr) {
                    // Clean up temp file if rename failed
                    fs.unlink(tempPath, () => {});
                    reject(renameErr);
                    return;
                }
                
                resolve();
            });
        });
    });
};

// 🛡️ ADDED: Helper function to validate profiles
const isValidProfile = (profile) => {
    return profile && 
           typeof profile === 'object' && 
           typeof profile.CharacterName === 'string' &&
           profile.CharacterName.length > 0;
};

// 📨 Upload endpoint (supports JSON + optional image) - OPTIMIZED
app.post("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        // 🚀 OPTIMIZATION: Use async file operations
        let existingLikeCount = 0;
        if (fs.existsSync(filePath)) {
            try {
                const existingProfile = await readProfileAsync(filePath);
                existingLikeCount = existingProfile.LikeCount || 0;
                console.log(`📝 Updating existing profile: ${newFileName} (preserving ${existingLikeCount} likes)`);
            } catch (err) {
                console.error(`Error reading existing profile: ${err}`);
            }
        } else {
            console.log(`🆕 Creating new profile: ${newFileName}`);
        }

        // Handle image upload
        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            // 🚀 OPTIMIZATION: Use async file operations
            await new Promise((resolve, reject) => {
                fs.rename(req.file.path, finalImagePath, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LikeCount = existingLikeCount;
        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        // 🚀 OPTIMIZATION: Async write + invalidate cache
        await writeProfileAsync(filePath, profile);
        galleryCache = null; // Invalidate cache

        console.log(`✅ Saved profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        if (profile.GalleryStatus) {
            console.log(`📝 Status: "${profile.GalleryStatus.substring(0, 50)}${profile.GalleryStatus.length > 50 ? '...' : ''}"`);
        }
        res.json(profile);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 📨 PUT endpoint for explicit updates - OPTIMIZED
app.put("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        let existingLikeCount = 0;
        if (fs.existsSync(filePath)) {
            try {
                const existingProfile = await readProfileAsync(filePath);
                existingLikeCount = existingProfile.LikeCount || 0;
                console.log(`🔄 PUT update for: ${newFileName} (preserving ${existingLikeCount} likes)`);
            } catch (err) {
                console.error(`Error reading existing profile: ${err}`);
            }
        }

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            await new Promise((resolve, reject) => {
                fs.rename(req.file.path, finalImagePath, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LikeCount = existingLikeCount;
        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await writeProfileAsync(filePath, profile);
        galleryCache = null; // Invalidate cache

        console.log(`✅ PUT updated profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        if (profile.GalleryStatus) {
            console.log(`📝 Status: "${profile.GalleryStatus.substring(0, 50)}${profile.GalleryStatus.length > 50 ? '...' : ''}"`);
        }
        res.json(profile);
    } catch (error) {
        console.error('PUT error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 📥 View endpoint - OPTIMIZED with error handling + PRIVACY PROTECTION
app.get("/view/:name", async (req, res) => {
    try {
        const requestedName = decodeURIComponent(req.params.name);
        let filePath = path.join(profilesDir, `${requestedName}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                // 🛡️ PRIVACY: Remove sensitive local file paths
                const sanitizedProfile = sanitizeProfileResponse(profile);
                return res.json(sanitizedProfile);
            } catch (err) {
                console.error(`Error reading profile ${requestedName}:`, err.message);
                // Continue to search for alternative profiles
            }
        }

        // 🚀 OPTIMIZATION: Use async operations for file search
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json') // Skip friends files
                ));
            });
        });

        const matchingProfiles = [];
        const expectedSuffix = `_${requestedName}.json`;

        // 🚀 OPTIMIZATION: Process files in batches to avoid blocking
        for (let i = 0; i < profileFiles.length; i += 5) {
            const batch = profileFiles.slice(i, i + 5);
            
            await Promise.all(batch.map(async (file) => {
                if (file.endsWith(expectedSuffix)) {
                    const fullPath = path.join(profilesDir, file);
                    try {
                        const stats = await new Promise((resolve, reject) => {
                            fs.stat(fullPath, (err, stats) => {
                                if (err) reject(err);
                                else resolve(stats);
                            });
                        });
                        const profileData = await readProfileAsync(fullPath);
                        
                        // Validate profile before using
                        if (isValidProfile(profileData)) {
                            matchingProfiles.push({
                                file: file,
                                lastModified: stats.mtime,
                                profile: profileData
                            });
                        }
                    } catch (err) {
                        console.error(`Error processing ${file}:`, err.message);
                    }
                }
            }));
        }

        if (matchingProfiles.length === 0) {
            return res.status(404).json({ error: "Profile not found" });
        }

        matchingProfiles.sort((a, b) => b.lastModified - a.lastModified);
        console.log(`📖 Found ${matchingProfiles.length} profiles for ${requestedName}, returning most recent: ${matchingProfiles[0].file}`);
        
        // 🛡️ PRIVACY: Sanitize before sending
        const sanitizedProfile = sanitizeProfileResponse(matchingProfiles[0].profile);
        res.json(sanitizedProfile);
    } catch (err) {
        console.error(`Error in view endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// 📚 Gallery endpoint - WITH AUTHENTICATION AND PRIVACY PROTECTION
app.get("/gallery", async (req, res) => {
    try {
        // 🔐 AUTHENTICATION CHECK
        const isPlugin = req.headers['x-plugin-auth'] === 'cs-plus-gallery-client';
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;
        
        console.log(`📸 Gallery request - Plugin: ${isPlugin}, Admin: ${isAdmin}`);
        
        // 🚀 OPTIMIZATION: Return cached data if available and fresh
        const now = Date.now();
        if (galleryCache && (now - galleryCacheTime) < CACHE_DURATION) {
            console.log(`📸 Gallery: Serving cached data (${galleryCache.length} profiles)`);
            
            if (isPlugin || isAdmin) {
                return res.json(galleryCache); // Full data
            } else {
                return res.json(sanitizeGalleryData(galleryCache)); // Sanitized data
            }
        }

        console.log(`📸 Gallery: Building fresh cache...`);
        
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json') // Skip friends files
                ));
            });
        });

        const showcaseProfiles = [];
        let skippedFiles = 0;

        // 🚀 OPTIMIZATION: Process files in smaller batches to prevent blocking
        for (let i = 0; i < profileFiles.length; i += 10) {
            const batch = profileFiles.slice(i, i + 10);
            
            const batchResults = await Promise.all(batch.map(async (file) => {
                const characterId = file.replace('.json', '');
                const filePath = path.join(profilesDir, file);
                
                try {
                    const profileData = await readProfileAsync(filePath);
                    
                    // 🛡️ ADDED: Validate profile data
                    if (!isValidProfile(profileData)) {
                        console.error(`[Error] Invalid profile structure in ${file}`);
                        skippedFiles++;
                        return null;
                    }
                    
                    // Only include profiles that want to be showcased
                    if (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2) {
                        const underscoreIndex = characterId.indexOf('_');
                        let csCharacterName, physicalCharacterName;
                        
                        if (underscoreIndex > 0) {
                            csCharacterName = characterId.substring(0, underscoreIndex);
                            physicalCharacterName = characterId.substring(underscoreIndex + 1);
                        } else {
                            csCharacterName = profileData.CharacterName || characterId.split('@')[0];
                            physicalCharacterName = characterId;
                        }

                        return {
                            CharacterId: characterId,
                            CharacterName: csCharacterName,
                            Server: extractServerFromName(physicalCharacterName),
                            ProfileImageUrl: profileData.ProfileImageUrl || null,
                            Tags: profileData.Tags || "",
                            Bio: profileData.Bio || "",
                            GalleryStatus: profileData.GalleryStatus || "",
                            Race: profileData.Race || "",
                            Pronouns: profileData.Pronouns || "",
                            Links: profileData.Links || "",
                            LikeCount: profileData.LikeCount || 0,
                            LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                            ImageZoom: profileData.ImageZoom || 1.0,
                            ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 }
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`[Error] Failed to process profile ${file}:`, err.message);
                    skippedFiles++;
                    return null;
                }
            }));

            // Add non-null results to showcase profiles
            batchResults.forEach(result => {
                if (result) showcaseProfiles.push(result);
            });
        }

        // Sort by like count
        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        // 🚀 OPTIMIZATION: Cache the results and return appropriate data
        galleryCache = showcaseProfiles;
        galleryCacheTime = now;
        
        if (skippedFiles > 0) {
            console.log(`📸 Gallery: Cached ${showcaseProfiles.length} profiles (skipped ${skippedFiles} corrupted files)`);
        } else {
            console.log(`📸 Gallery: Cached ${showcaseProfiles.length} profiles`);
        }
        
        // Return full or sanitized data based on authentication
        if (isPlugin || isAdmin) {
            console.log(`📸 Gallery: Returning full data (${isPlugin ? 'plugin' : 'admin'} access)`);
            res.json(showcaseProfiles); // Full data
        } else {
            console.log(`📸 Gallery: Returning sanitized data (public access)`);
            res.json(sanitizeGalleryData(showcaseProfiles)); // Sanitized data
        }
        
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// 💖 Like endpoint - OPTIMIZED with error handling
app.post("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const filePath = path.join(profilesDir, `${characterId}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Profile not found" });
        }

        const profile = await readProfileAsync(filePath);
        
        // Validate profile before modifying
        if (!isValidProfile(profile)) {
            return res.status(400).json({ error: "Invalid profile data" });
        }
        
        profile.LikeCount = (profile.LikeCount || 0) + 1;
        profile.LastUpdated = new Date().toISOString();
        
        await writeProfileAsync(filePath, profile);
        galleryCache = null; // Invalidate cache
        
        console.log(`👍 Liked profile: ${characterId} (now ${profile.LikeCount} likes)`);
        res.json({ LikeCount: profile.LikeCount });
        
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

// 💔 Unlike endpoint - OPTIMIZED with error handling
app.delete("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const filePath = path.join(profilesDir, `${characterId}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Profile not found" });
        }

        const profile = await readProfileAsync(filePath);
        
        // Validate profile before modifying
        if (!isValidProfile(profile)) {
            return res.status(400).json({ error: "Invalid profile data" });
        }
        
        profile.LikeCount = Math.max(0, (profile.LikeCount || 0) - 1);
        profile.LastUpdated = new Date().toISOString();
        
        await writeProfileAsync(filePath, profile);
        galleryCache = null; // Invalidate cache
        
        console.log(`👎 Unliked profile: ${characterId} (now ${profile.LikeCount} likes)`);
        res.json({ LikeCount: profile.LikeCount });
        
    } catch (err) {
        console.error('Unlike error:', err);
        res.status(500).json({ error: 'Failed to unlike profile' });
    }
});

// 🤝 FRIENDS SYSTEM ENDPOINTS

// Endpoint to update your friends list
app.post("/friends/update-follows", async (req, res) => {
    try {
        const { character, following } = req.body;
        
        if (!character || !Array.isArray(following)) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        const followsFile = path.join(profilesDir, `${character}_follows.json`);
        const followsData = {
            character: character,
            following: following,
            lastUpdated: new Date().toISOString()
        };
        
        await writeProfileAsync(followsFile, followsData);
        
        console.log(`👥 Updated friends for ${character}: ${following.length} following`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update friends error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to check mutual friends
app.post("/friends/check-mutual", async (req, res) => {
    try {
        const { character, following } = req.body;
        
        if (!character || !Array.isArray(following)) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        const mutualFriends = [];
        
        // Check each person you follow to see if they follow you back
        for (const followedPerson of following) {
            try {
                const followsFile = path.join(profilesDir, `${followedPerson}_follows.json`);
                
                if (fs.existsSync(followsFile)) {
                    const theirFollows = await readProfileAsync(followsFile);
                    
                    // If they follow you back, it's mutual
                    if (theirFollows.following && theirFollows.following.includes(character)) {
                        mutualFriends.push(followedPerson);
                    }
                }
            } catch (err) {
                console.error(`Error checking follows for ${followedPerson}:`, err.message);
            }
        }
        
        console.log(`🤝 ${character} has ${mutualFriends.length} mutual friends`);
        res.json({ mutualFriends });
        
    } catch (error) {
        console.error('Check mutual error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to extract server from character name
function extractServerFromName(characterName) {
    const parts = characterName.split('@');
    return parts.length > 1 ? parts[1] : 'Unknown';
}

// 🚀 OPTIMIZATION: Graceful shutdown
process.on('SIGTERM', () => {
    console.log('💤 Server shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
    console.log(`📁 Profiles directory: ${profilesDir}`);
    console.log(`🖼️ Images directory: ${imagesDir}`);
    console.log(`🚀 Features: Gallery, Likes, Friends System, Status Support, Caching, Error Recovery, Privacy Protection`);
    console.log(`🤝 Friends endpoints: /friends/update-follows, /friends/check-mutual`);
    console.log(`📝 Status support: GalleryStatus field included in gallery responses`);
    console.log(`🔐 Privacy: Gallery data sanitized for public access, full data for authenticated plugin requests`);
    console.log(`🛡️ Profile privacy: CustomImagePath removed from /view responses`);
    
    if (process.env.ADMIN_SECRET_KEY) {
        console.log(`👑 Admin access enabled`);
    } else {
        console.log(`⚠️  Admin access disabled - set ADMIN_SECRET_KEY environment variable to enable`);
    }
});
