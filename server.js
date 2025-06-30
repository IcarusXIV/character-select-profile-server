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
    const characterName = decodeURIComponent(req.params.name);
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

    // 🖼 Save image (if provided)
    if (req.file) {
        const ext = path.extname(req.file.originalname) || ".png";
        const safeFileName = characterName.replace(/[^\w@-]/g, "_") + ext;
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

    // 💾 Save profile JSON
    const filePath = path.join(profilesDir, `${characterName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));

    res.json(profile); // ✅ Return the updated profile including ProfileImageUrl
});

// 📥 View endpoint
app.get("/view/:name", (req, res) => {
    const characterName = decodeURIComponent(req.params.name);
    const filePath = path.join(profilesDir, `${characterName}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    const profile = fs.readFileSync(filePath, "utf-8");
    res.json(JSON.parse(profile));
});

// 📚 Gallery endpoint - Get all showcase profiles (FIXED TO USE FILENAME AS ID)
app.get("/gallery", (req, res) => {
    try {
        const profileFiles = fs.readdirSync(profilesDir).filter(file => file.endsWith('.json'));
        const showcaseProfiles = [];

        for (const file of profileFiles) {
            const characterId = file.replace('.json', ''); // This is the actual filename we need for likes
            const filePath = path.join(profilesDir, file);
            
            try {
                const profileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                
                // Only include profiles that want to be showcased
                if (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2) {
                    showcaseProfiles.push({
                        CharacterId: characterId, // NEW: The actual filename for API calls
                        CharacterName: profileData.CharacterName || characterId.split('@')[0],
                        Server: extractServerFromName(characterId),
                        ProfileImageUrl: profileData.ProfileImageUrl || null,
                        Tags: profileData.Tags || "",
                        Bio: profileData.Bio || "",
                        Race: profileData.Race || "",
                        Pronouns: profileData.Pronouns || "",
                        LikeCount: profileData.LikeCount || 0,
                        LastUpdated: profileData.LastUpdated || new Date().toISOString()
                    });
                }
            } catch (err) {
                console.error(`Error reading profile ${file}:`, err);
            }
        }

        // Sort by most liked first
        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        res.json(showcaseProfiles);
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// 💖 Like endpoint (FIXED RESPONSE FORMAT)
app.post("/gallery/:name/like", (req, res) => {
    const characterName = decodeURIComponent(req.params.name);
    const filePath = path.join(profilesDir, `${characterName}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = (profile.LikeCount || 0) + 1;
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
        // Return PascalCase to match C# client expectations
        res.json({ LikeCount: profile.LikeCount });
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

// 💔 Unlike endpoint (FIXED RESPONSE FORMAT)
app.delete("/gallery/:name/like", (req, res) => {
    const characterName = decodeURIComponent(req.params.name);
    const filePath = path.join(profilesDir, `${characterName}.json`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Profile not found" });
    }

    try {
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        profile.LikeCount = Math.max(0, (profile.LikeCount || 0) - 1);
        profile.LastUpdated = new Date().toISOString();
        
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        
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
