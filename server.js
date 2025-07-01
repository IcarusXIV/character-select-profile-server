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

// 🔧 NEW: Helper function to generate CS+ character filename
function generateCSCharacterFileName(csCharacterName, inGameCharacterName) {
    // Format: "CSCharacter_InGameCharacter@Server.json"
    const safeCsName = csCharacterName.replace(/[^\w-]/g, "_");
    const safeInGameName = inGameCharacterName.replace(/[^\w@-]/g, "_");
    return `${safeCsName}_${safeInGameName}.json`;
}

// 🔧 NEW: Helper function to parse CS+ character from filename
function parseCSCharacterFromFileName(fileName) {
    const nameWithoutExt = fileName.replace('.json', '');
    const parts = nameWithoutExt.split('_');
    
    if (parts.length >= 2) {
        const csCharacter = parts[0].replace(/_/g, ' '); // Convert back from safe format
        const inGameCharacter = parts.slice(1).join('_').replace(/_/g, ' '); // Handle names with underscores
        return { csCharacter, inGameCharacter, originalFileName: nameWithoutExt };
    }
    
    // Fallback for old format files
    return { csCharacter: null, inGameCharacter: nameWithoutExt, originalFileName: nameWithoutExt };
}

// 📨 Upload endpoint (UPDATED for CS+ character storage)
app.post("/upload/:name", upload.single("image"), (req, res) => {
    const inGameCharacterName = decodeURIComponent(req.params.name);
    const profileJson = req.body.profile;
    
    // 🔥 NEW: Get CS+ character name from headers
    const csCharacterName = req.headers['x-cs-character-name'];
    
    console.log(`Upload request - CS+ Character: ${csCharacterName}, In-Game: ${inGameCharacterName}`);

    if (!profileJson) {
        return res.status(400).send("Missing profile data.");
    }

    if (!csCharacterName) {
        return res.status(400).send("Missing CS+ character name in headers.");
    }

    let profile;
    try {
        profile = JSON.parse(profileJson);
    } catch (err) {
        return res.status(400).send("Invalid profile JSON.");
    }

    // 🔧 NEW: Generate CS+ character specific filename
    const fileName = generateCSCharacterFileName(csCharacterName, inGameCharacterName);
    const filePath = path.join(profilesDir, fileName);
    
    // 🔄 NEW: Load existing profile to preserve likes
    let existingProfile = {};
    if (fs.existsSync(filePath)) {
        try {
            existingProfile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            console.log(`Preserving existing data for ${fileName} - Likes: ${existingProfile.LikeCount || 0}`);
        } catch (err) {
            console.error(`Error reading existing profile ${fileName}:`, err);
        }
    }

    // 🖼 Save image (if provided)
    if (req.file) {
        const ext = path.extname(req.file.originalname) || ".png";
        const safeFileName = `${csCharacterName.replace(/[^\w-]/g, "_")}_${inGameCharacterName.replace(/[^\w@-]/g, "_")}${ext}`;
        const finalImagePath = path.join(imagesDir, safeFileName);
        fs.renameSync(req.file.path, finalImagePath);

        // 🔗 Set image URL in profile
        profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
    }

    // 🔥 NEW: Preserve existing LikeCount and other important data
    profile.LikeCount = existingProfile.LikeCount || 0;
    profile.CSCharacterName = csCharacterName; // Store CS+ character name
    profile.InGameCharacterName = inGameCharacterName; // Store in-game character name
    
    // Set LastUpdated
    profile.LastUpdated = new Date().toISOString();

    // 💾 Save profile JSON with CS+ character specific filename
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    
    console.log(`Profile saved successfully: ${fileName}`);
    res.json(profile); // ✅ Return the updated profile including ProfileImageUrl
});

// 📥 View endpoint (UPDATED for CS+ character lookup)
app.get("/view/:name", (req, res) => {
    const characterIdentifier = decodeURIComponent(req.params.name);
    const csCharacterName = req.headers['x-cs-character-name'];
    
    let filePath;
    
    if (csCharacterName) {
        // 🔥 NEW: Look for CS+ character specific file first
        const fileName = generateCSCharacterFileName(csCharacterName, characterIdentifier);
        filePath = path.join(profilesDir, fileName);
        console.log(`Looking for CS+ character file: ${fileName}`);
    }
    
    // Fallback to old format if CS+ specific file doesn't exist
    if (!filePath || !fs.existsSync(filePath)) {
        filePath = path.join(profilesDir, `${characterIdentifier}.json`);
        console.log(`Fallback to legacy file: ${characterIdentifier}.json`);
    }

    if (!fs.existsSync(filePath)) {
        console.log(`Profile not found: ${characterIdentifier}`);
        return res.status(404).json({ error: "Profile not found" });
    }

    const profile = fs.readFileSync(filePath, "utf-8");
    res.json(JSON.parse(profile));
});

// 📚 Gallery endpoint (UPDATED for CS+ character support)
app.get("/gallery", (req, res) => {
    try {
        const profileFiles = fs.readdirSync(profilesDir).filter(file => file.endsWith('.json'));
        const showcaseProfiles = [];

        for (const file of profileFiles) {
            const filePath = path.join(profilesDir, file);
            
            try {
                const profileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                
                console.log(`Checking profile ${file}: Sharing = ${profileData.Sharing}`);
                
                // FIXED: Proper sharing check - only include ShowcasePublic profiles
                const isShowcasePublic = profileData.Sharing === 'ShowcasePublic' || 
                                        profileData.Sharing === 2 || 
                                        profileData.Sharing === 'ShowcasePublic';
                
                if (isShowcasePublic) {
                    const parsedName = parseCSCharacterFromFileName(file);
                    
                    // Generate proper character ID for API calls
                    const characterId = parsedName.originalFileName;
                    
                    // FIXED: Use proper character name priority
                    let displayName = profileData.CSCharacterName || // CS+ character name first
                                     profileData.CharacterName ||   // Then regular character name  
                                     parsedName.csCharacter ||      // Then parsed CS name
                                     parsedName.inGameCharacter.split('@')[0]; // Finally in-game name
                    
                    showcaseProfiles.push({
                        CharacterId: characterId,
                        CharacterName: displayName,
                        Server: extractServerFromName(parsedName.inGameCharacter),
                        ProfileImageUrl: profileData.ProfileImageUrl || null,
                        Tags: profileData.Tags || "",
                        Bio: profileData.Bio || "",
                        Race: profileData.Race || "",
                        Pronouns: profileData.Pronouns || "",
                        LikeCount: profileData.LikeCount || 0,
                        LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                        
                        // Include crop data for proper gallery image display
                        ImageZoom: profileData.ImageZoom || 1.0,
                        ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                        
                        // Include CS+ character info
                        CSCharacterName: profileData.CSCharacterName || null,
                        InGameCharacterName: profileData.InGameCharacterName || parsedName.inGameCharacter
                    });
                    
                    console.log(`Added to gallery: ${displayName} (CS+: ${profileData.CSCharacterName})`);
                } else {
                    console.log(`Skipped profile ${file}: Sharing setting ${profileData.Sharing} is not ShowcasePublic`);
                }
            } catch (err) {
                console.error(`Error reading profile ${file}:`, err);
            }
        }

        // Sort by most liked first
        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        console.log(`Gallery returned ${showcaseProfiles.length} profiles`);
        res.json(showcaseProfiles);
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// 💖 Like endpoint (UPDATED for CS+ character files)
app.post("/gallery/:name/like", (req, res) => {
    const characterIdentifier = decodeURIComponent(req.params.name);
    const csCharacterKey = req.headers['x-character-key']; // CS+ character doing the liking
    
    console.log(`Like request - Target: ${characterIdentifier}, Liker: ${csCharacterKey}`);
    
    // Find the actual file (could be CS+ format or legacy format)
    let filePath = path.join(profilesDir, `${characterIdentifier}.json`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = (profile.LikeCount || 0) + 1;
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
        console.log(`Like added - New count: ${profile.LikeCount}`);
        
        // Return PascalCase to match C# client expectations
        res.json({ LikeCount: profile.LikeCount });
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

// 💔 Unlike endpoint (UPDATED for CS+ character files)
app.delete("/gallery/:name/like", (req, res) => {
    const characterIdentifier = decodeURIComponent(req.params.name);
    const csCharacterKey = req.headers['x-character-key']; // CS+ character doing the unliking
    
    console.log(`Unlike request - Target: ${characterIdentifier}, Unliker: ${csCharacterKey}`);
    
    // Find the actual file (could be CS+ format or legacy format)
    let filePath = path.join(profilesDir, `${characterIdentifier}.json`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = Math.max(0, (profile.LikeCount || 0) - 1);
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
        console.log(`Like removed - New count: ${profile.LikeCount}`);
        
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
});
