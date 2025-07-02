const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// Create directories if they don't exist
const profilesDir = path.join(__dirname, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

const imagesDir = path.join(__dirname, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Static route to serve uploaded images
app.use("/images", express.static(path.join(__dirname, "public", "images")));

const upload = multer({ dest: "uploads/" }); // temp folder for uploads

app.use(cors());
app.use(bodyParser.json());

// 📨 Upload endpoint (supports JSON + optional image)
app.post("/upload/:name", upload.single("image"), (req, res) => {
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

    // Extract CS+ character name from profile
    const csCharacterName = profile.CharacterName;
    if (!csCharacterName) {
        return res.status(400).send("Missing CharacterName in profile data.");
    }

    // Sanitize CS+ character name (allow spaces, numbers, letters, basic punctuation)
    const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
    
    // New filename format: {CS+Name}_{PhysicalName}
    const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;

    // 🖼 Save image (if provided)
    if (req.file) {
        const ext = path.extname(req.file.originalname) || ".png";
        const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
        const finalImagePath = path.join(imagesDir, safeFileName);
        fs.renameSync(req.file.path, finalImagePath);

        // 🔗 Set image URL in profile
        profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
    }

    // Initialize LikeCount if not present
    if (profile.LikeCount === undefined) {
        profile.LikeCount = 0;
    }

    // Set LastUpdated
    profile.LastUpdated = new Date().toISOString();
    profile.LastActiveTime = new Date().toISOString();

    // 💾 Save profile JSON with new filename format
    const filePath = path.join(profilesDir, `${newFileName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));

    console.log(`✅ Saved profile: ${newFileName}.json`);
    res.json(profile); // ✅ Return the updated profile including ProfileImageUrl
});

// 📥 View endpoint - handles both old and new formats, returns most recent for physical character
app.get("/view/:name", (req, res) => {
    const requestedName = decodeURIComponent(req.params.name);
    
    // First try direct lookup (new format)
    let filePath = path.join(profilesDir, `${requestedName}.json`);
    
    if (fs.existsSync(filePath)) {
        const profile = fs.readFileSync(filePath, "utf-8");
        return res.json(JSON.parse(profile));
    }

    // If not found, assume it's a physical character name and find most recent CS+ profile
    try {
        const profileFiles = fs.readdirSync(profilesDir).filter(file => file.endsWith('.json'));
        const matchingProfiles = [];

        for (const file of profileFiles) {
            // Check if filename ends with _{requestedName}.json
            const expectedSuffix = `_${requestedName}.json`;
            if (file.endsWith(expectedSuffix)) {
                const fullPath = path.join(profilesDir, file);
                const stats = fs.statSync(fullPath);
                const profileData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                
                matchingProfiles.push({
                    file: file,
                    lastModified: stats.mtime,
                    profile: profileData
                });
            }
        }

        if (matchingProfiles.length === 0) {
            return res.status(404).json({ error: "Profile not found" });
        }

        // Return the most recently modified profile
        matchingProfiles.sort((a, b) => b.lastModified - a.lastModified);
        console.log(`📖 Found ${matchingProfiles.length} profiles for ${requestedName}, returning most recent: ${matchingProfiles[0].file}`);
        
        res.json(matchingProfiles[0].profile);
    } catch (err) {
        console.error(`Error in view endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// 📚 Gallery endpoint - Get all showcase profiles
app.get("/gallery", (req, res) => {
    try {
        const profileFiles = fs.readdirSync(profilesDir).filter(file => file.endsWith('.json'));
        const showcaseProfiles = [];

        for (const file of profileFiles) {
            const characterId = file.replace('.json', ''); // Full filename without .json
            const filePath = path.join(profilesDir, file);
            
            try {
                const profileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                
                // Only include profiles that want to be showcased
                if (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2) {
                    // Parse CS+ character name and physical character name from filename
                    const underscoreIndex = characterId.indexOf('_');
                    let csCharacterName, physicalCharacterName;
                    
                    if (underscoreIndex > 0) {
                        // New format: CS+Name_Physical@Server
                        csCharacterName = characterId.substring(0, underscoreIndex);
                        physicalCharacterName = characterId.substring(underscoreIndex + 1);
                    } else {
                        // Fallback for any remaining old format files
                        csCharacterName = profileData.CharacterName || characterId.split('@')[0];
                        physicalCharacterName = characterId;
                    }

                    showcaseProfiles.push({
                        CharacterId: characterId, // Full filename for API calls (CS+Name_Physical@Server)
                        CharacterName: csCharacterName, // CS+ character name for display
                        Server: extractServerFromName(physicalCharacterName),
                        ProfileImageUrl: profileData.ProfileImageUrl || null,
                        Tags: profileData.Tags || "",
                        Bio: profileData.Bio || "",
                        Race: profileData.Race || "",
                        Pronouns: profileData.Pronouns || "",
                        LikeCount: profileData.LikeCount || 0,
                        LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                        
                        // Include crop data for proper gallery image display
                        ImageZoom: profileData.ImageZoom || 1.0,
                        ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 }
                    });
                }
            } catch (err) {
                console.error(`Error reading profile ${file}:`, err);
            }
        }

        // Sort by individual profile like counts
        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        console.log(`📸 Gallery: Found ${showcaseProfiles.length} showcase profiles`);
        res.json(showcaseProfiles);
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// 💖 Like endpoint
app.post("/gallery/:name/like", (req, res) => {
    const characterId = decodeURIComponent(req.params.name); // Now includes CS+ prefix
    const filePath = path.join(profilesDir, `${characterId}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = (profile.LikeCount || 0) + 1;
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
        console.log(`👍 Liked profile: ${characterId} (now ${profile.LikeCount} likes)`);
        
        // Return PascalCase to match C# client expectations
        res.json({ LikeCount: profile.LikeCount });
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

// 💔 Unlike endpoint
app.delete("/gallery/:name/like", (req, res) => {
    const characterId = decodeURIComponent(req.params.name); // Now includes CS+ prefix
    const filePath = path.join(profilesDir, `${characterId}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = Math.max(0, (profile.LikeCount || 0) - 1);
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
        console.log(`👎 Unliked profile: ${characterId} (now ${profile.LikeCount} likes)`);
        
        // Return PascalCase to match C# client expectations
        res.json({ LikeCount: profile.LikeCount });
    } catch (err) {
        console.error('Unlike error:', err);
        res.status(500).json({ error: 'Failed to unlike profile' });
    }
});

// Helper function to extract server from character name
function extractServerFromName(characterName) {
    const parts = characterName.split('@');
    return parts.length > 1 ? parts[1] : 'Unknown';
}

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
    console.log(`📁 Profiles directory: ${profilesDir}`);
    console.log(`🖼️ Images directory: ${imagesDir}`);
});
