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

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
});
