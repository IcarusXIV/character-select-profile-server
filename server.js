const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// 🚀 RAILWAY VOLUME SETUP
// ===============================
// Use mounted volume in production, local directory in development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
console.log(`📁 Using data directory: ${DATA_DIR}`);

// Create directories if they don't exist
const profilesDir = path.join(DATA_DIR, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

const imagesDir = path.join(DATA_DIR, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Create uploads directory within the volume to avoid cross-device issues
const uploadsDir = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Static route to serve uploaded images
app.use("/images", express.static(path.join(DATA_DIR, "public", "images")));

const upload = multer({ dest: uploadsDir });

// Gallery caching
let galleryCache = null;
let galleryCacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes cache

app.use(require('compression')());
app.use(cors());
app.use(bodyParser.json());

// Database files - ALL NOW PERSISTENT WITH VOLUMES
const likesDbFile = path.join(DATA_DIR, "likes_database.json");
const friendsDbFile = path.join(DATA_DIR, "friends_database.json");
const announcementsDbFile = path.join(DATA_DIR, "announcements_database.json");
const reportsDbFile = path.join(DATA_DIR, "reports_database.json");
const moderationDbFile = path.join(DATA_DIR, "moderation_database.json");

// 💾 DATABASE CLASSES
class LikesDatabase {
    constructor() {
        this.likes = new Map();
        this.likeCounts = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(likesDbFile)) {
                const data = JSON.parse(fs.readFileSync(likesDbFile, 'utf-8'));
                this.likes = new Map(data.likes.map(([k, v]) => [k, new Set(v)]));
                this.likeCounts = new Map(data.likeCounts);
                console.log(`💾 Loaded ${this.likeCounts.size} like records`);
            }
        } catch (err) {
            console.error('Error loading likes database:', err);
            this.likes = new Map();
            this.likeCounts = new Map();
        }
    }

    save() {
        try {
            const data = {
                likes: Array.from(this.likes.entries()).map(([k, v]) => [k, Array.from(v)]),
                likeCounts: Array.from(this.likeCounts.entries()),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = likesDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(likesDbFile)) {
                fs.copyFileSync(likesDbFile, likesDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, likesDbFile);
        } catch (err) {
            console.error('Error saving likes database:', err);
        }
    }

    addLike(characterId, likerId) {
        if (!this.likes.has(characterId)) {
            this.likes.set(characterId, new Set());
        }
        
        const wasNew = !this.likes.get(characterId).has(likerId);
        if (wasNew) {
            this.likes.get(characterId).add(likerId);
            this.likeCounts.set(characterId, (this.likeCounts.get(characterId) || 0) + 1);
            this.save();
        }
        return this.likeCounts.get(characterId) || 0;
    }

    removeLike(characterId, likerId) {
        if (this.likes.has(characterId)) {
            const wasRemoved = this.likes.get(characterId).delete(likerId);
            if (wasRemoved) {
                const newCount = Math.max(0, (this.likeCounts.get(characterId) || 0) - 1);
                this.likeCounts.set(characterId, newCount);
                this.save();
                return newCount;
            }
        }
        return this.likeCounts.get(characterId) || 0;
    }

    getLikeCount(characterId) {
        return this.likeCounts.get(characterId) || 0;
    }
}

class FriendsDatabase {
    constructor() {
        this.friends = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(friendsDbFile)) {
                const data = JSON.parse(fs.readFileSync(friendsDbFile, 'utf-8'));
                this.friends = new Map(data.friends.map(([k, v]) => [k, new Set(v)]));
                console.log(`🤝 Loaded ${this.friends.size} friend records`);
            }
        } catch (err) {
            console.error('Error loading friends database:', err);
            this.friends = new Map();
        }
    }

    save() {
        try {
            const data = {
                friends: Array.from(this.friends.entries()).map(([k, v]) => [k, Array.from(v)]),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = friendsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(friendsDbFile)) {
                fs.copyFileSync(friendsDbFile, friendsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, friendsDbFile);
        } catch (err) {
            console.error('Error saving friends database:', err);
        }
    }

    updateFriends(characterId, friendsList) {
        this.friends.set(characterId, new Set(friendsList));
        this.save();
    }

    getFriends(characterId) {
        return Array.from(this.friends.get(characterId) || []);
    }

    getMutualFriends(characterId) {
        const myFriends = this.friends.get(characterId) || new Set();
        const mutuals = [];
        
        for (const friendId of myFriends) {
            const theirFriends = this.friends.get(friendId) || new Set();
            if (theirFriends.has(characterId)) {
                mutuals.push(friendId);
            }
        }
        
        return mutuals;
    }
}

class AnnouncementsDatabase {
    constructor() {
        this.announcements = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(announcementsDbFile)) {
                const data = JSON.parse(fs.readFileSync(announcementsDbFile, 'utf-8'));
                this.announcements = data.announcements || [];
                console.log(`📢 Loaded ${this.announcements.length} announcements`);
            }
        } catch (err) {
            console.error('Error loading announcements database:', err);
            this.announcements = [];
        }
    }

    save() {
        try {
            const data = {
                announcements: this.announcements,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = announcementsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(announcementsDbFile)) {
                fs.copyFileSync(announcementsDbFile, announcementsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, announcementsDbFile);
        } catch (err) {
            console.error('Error saving announcements database:', err);
        }
    }

    addAnnouncement(title, message, type = 'info') {
        const announcement = {
            id: crypto.randomUUID(),
            title,
            message,
            type,
            createdAt: new Date().toISOString(),
            active: true
        };
        
        this.announcements.unshift(announcement);
        this.save();
        console.log(`📢 Added announcement: ${title}`);
        return announcement;
    }

    getActiveAnnouncements() {
        return this.announcements.filter(a => a.active);
    }

    getAllAnnouncements() {
        return this.announcements;
    }

    deactivateAnnouncement(id) {
        const announcement = this.announcements.find(a => a.id === id);
        if (announcement) {
            announcement.active = false;
            this.save();
            return true;
        }
        return false;
    }

    deleteAnnouncement(id) {
        const index = this.announcements.findIndex(a => a.id === id);
        if (index !== -1) {
            this.announcements.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

class ReportsDatabase {
    constructor() {
        this.reports = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(reportsDbFile)) {
                const data = JSON.parse(fs.readFileSync(reportsDbFile, 'utf-8'));
                this.reports = data.reports || [];
                console.log(`🚨 Loaded ${this.reports.length} reports`);
            }
        } catch (err) {
            console.error('Error loading reports database:', err);
            this.reports = [];
        }
    }

    save() {
        try {
            const data = {
                reports: this.reports,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = reportsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(reportsDbFile)) {
                fs.copyFileSync(reportsDbFile, reportsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, reportsDbFile);
        } catch (err) {
            console.error('Error saving reports database:', err);
        }
    }

    addReport(reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details) {
        const report = {
            id: crypto.randomUUID(),
            reportedCharacterId,
            reportedCharacterName,
            reporterCharacter,
            reason,
            details,
            status: 'pending',
            createdAt: new Date().toISOString(),
            reviewedAt: null,
            reviewedBy: null,
            adminNotes: null
        };
        
        this.reports.unshift(report);
        this.save();
        console.log(`🚨 New report: ${reportedCharacterName} reported for ${reason}`);
        return report;
    }

    getReports(status = null) {
        if (status) {
            return this.reports.filter(r => r.status === status);
        }
        return this.reports;
    }

    updateReportStatus(reportId, status, adminNotes = null) {
        const report = this.reports.find(r => r.id === reportId);
        if (report) {
            report.status = status;
            report.reviewedAt = new Date().toISOString();
            report.adminNotes = adminNotes;
            this.save();
            return true;
        }
        return false;
    }
}

class ModerationDatabase {
    constructor() {
        this.actions = [];
        this.bannedProfiles = new Set();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(moderationDbFile)) {
                const data = JSON.parse(fs.readFileSync(moderationDbFile, 'utf-8'));
                this.actions = data.actions || [];
                this.bannedProfiles = new Set(data.bannedProfiles || []);
                console.log(`🛡️ Loaded ${this.actions.length} moderation actions, ${this.bannedProfiles.size} banned profiles`);
            }
        } catch (err) {
            console.error('Error loading moderation database:', err);
            this.actions = [];
            this.bannedProfiles = new Set();
        }
    }

    save() {
        try {
            const data = {
                actions: this.actions,
                bannedProfiles: Array.from(this.bannedProfiles),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = moderationDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(moderationDbFile)) {
                fs.copyFileSync(moderationDbFile, moderationDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, moderationDbFile);
        } catch (err) {
            console.error('Error saving moderation database:', err);
        }
    }

    logAction(action, characterId, characterName, reason, adminId) {
        const moderationAction = {
            id: crypto.randomUUID(),
            action,
            characterId,
            characterName,
            reason,
            adminId,
            timestamp: new Date().toISOString()
        };
        
        this.actions.unshift(moderationAction);
        this.save();
        console.log(`🛡️ Moderation: ${action} on ${characterName} by ${adminId}`);
        return moderationAction;
    }

    banProfile(characterId) {
        this.bannedProfiles.add(characterId);
        this.save();
    }

    unbanProfile(characterId) {
        this.bannedProfiles.delete(characterId);
        this.save();
    }

    isProfileBanned(characterId) {
        return this.bannedProfiles.has(characterId);
    }

    getActions() {
        return this.actions;
    }
}

// Initialize databases
const likesDB = new LikesDatabase();
const friendsDB = new FriendsDatabase();
const announcementsDB = new AnnouncementsDatabase();
const reportsDB = new ReportsDatabase();
const moderationDB = new ModerationDatabase();

// Admin authentication middleware
function requireAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Helper functions (keeping all the existing ones)

// Safe file move function that handles cross-device moves
async function safeFileMove(sourcePath, destPath) {
    try {
        // Try rename first (fastest)
        await new Promise((resolve, reject) => {
            fs.rename(sourcePath, destPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (err) {
        if (err.code === 'EXDEV') {
            // Cross-device link error, fall back to copy + delete
            console.log('Cross-device move detected, using copy + delete');
            await new Promise((resolve, reject) => {
                fs.copyFile(sourcePath, destPath, (copyErr) => {
                    if (copyErr) {
                        reject(copyErr);
                        return;
                    }
                    fs.unlink(sourcePath, (unlinkErr) => {
                        if (unlinkErr) console.warn('Failed to delete temp file:', unlinkErr);
                        resolve();
                    });
                });
            });
        } else {
            throw err;
        }
    }
}

async function cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName) {
    try {
        const allFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json') &&
                    file !== `${newFileName}.json`
                ));
            });
        });

        const oldVersions = [];
        
        for (const file of allFiles) {
            if (file.endsWith(`_${physicalCharacterName}.json`)) {
                try {
                    const filePath = path.join(profilesDir, file);
                    const oldProfile = await readProfileAsync(filePath);
                    
                    if (oldProfile.CharacterName === csCharacterName) {
                        oldVersions.push({ file, path: filePath });
                    }
                } catch (err) {
                    continue;
                }
            }
        }

        for (const oldVersion of oldVersions) {
            fs.unlinkSync(oldVersion.path);
        }
        
        if (oldVersions.length > 0) {
            galleryCache = null;
        }
    } catch (cleanupErr) {
        console.error('Error during cleanup:', cleanupErr.message);
    }
}

async function atomicWriteProfile(filePath, profile) {
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.backup';
    
    try {
        // Create backup if original exists
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupPath);
        }
        
        // Write directly using synchronous method to avoid temp file conflicts
        const jsonString = JSON.stringify(profile, null, 2);
        fs.writeFileSync(tempPath, jsonString, 'utf-8');
        
        // Atomic rename
        fs.renameSync(tempPath, filePath);
        
    } catch (error) {
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (cleanupErr) {
                console.warn('Failed to cleanup temp file:', cleanupErr);
            }
        }
        throw error;
    }
}

function sanitizeGalleryData(profiles) {
    return profiles.map(profile => ({
        CharacterId: generateSafeId(profile.CharacterName, profile.CharacterId),
        CharacterName: profile.CharacterName,
        Server: "Gallery",
        ProfileImageUrl: null,
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

function sanitizeProfileResponse(profile) {
    const sanitized = { ...profile };
    delete sanitized.CustomImagePath;
    return sanitized;
}

function generateSafeId(characterName, originalId) {
    return characterName.toLowerCase().replace(/\s+/g, '_') + '_' + 
           crypto.createHash('md5').update(originalId).digest('hex').substring(0, 8);
}

const readProfileAsync = (filePath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!data || data.trim().length === 0) {
                reject(new Error(`Profile file is empty: ${filePath}`));
                return;
            }
            
            try {
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseError) {
                console.error(`[Error] Invalid JSON in file ${filePath}:`, parseError.message);
                fs.unlink(filePath, (unlinkErr) => {
                    if (!unlinkErr) {
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
        let jsonString;
        try {
            jsonString = JSON.stringify(data, null, 2);
        } catch (stringifyError) {
            reject(stringifyError);
            return;
        }
        
        if (filePath.includes(' ')) {
            fs.writeFile(filePath, jsonString, 'utf-8', (writeErr) => {
                if (writeErr) reject(writeErr);
                else resolve();
            });
            return;
        }
        
        const tempPath = filePath + '.tmp';
        
        fs.writeFile(tempPath, jsonString, 'utf-8', (writeErr) => {
            if (writeErr) {
                reject(writeErr);
                return;
            }
            
            fs.rename(tempPath, filePath, (renameErr) => {
                if (renameErr) {
                    fs.unlink(tempPath, () => {});
                    reject(renameErr);
                    return;
                }
                resolve();
            });
        });
    });
};

const isValidProfile = (profile) => {
    return profile && 
           typeof profile === 'object' && 
           typeof profile.CharacterName === 'string' &&
           profile.CharacterName.length > 0;
};

function extractServerFromName(characterName) {
    const parts = characterName.split('@');
    return parts.length > 1 ? parts[1] : 'Unknown';
}

// =============================================================================
// 🖥️ ADMIN DASHBOARD - BUILT-IN HTML INTERFACE (WITH FIXES)
// =============================================================================

app.get("/admin", (req, res) => {
    const adminHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Character Select+ Admin Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            backdrop-filter: blur(10px);
        }
        
        .auth-section {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        
        .tabs {
            display: flex;
            margin-bottom: 20px;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        }
        
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: #ccc;
            transition: all 0.3s;
        }
        
        .tab.active {
            color: #4CAF50;
            border-bottom: 2px solid #4CAF50;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .profile-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        
        .profile-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            height: 200px; /* Fixed height for button alignment */
            display: flex;
            flex-direction: column;
        }
        
        .profile-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 10px;
        }
        
        .profile-info {
            flex: 1;
        }
        
        .profile-image {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            object-fit: cover;
            margin-left: 15px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .profile-image:hover {
            border-color: #4CAF50;
            transform: scale(1.05);
        }
        
        .profile-image-placeholder {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            margin-left: 15px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #666;
        }
        
        .profile-name {
            font-weight: bold;
            color: #4CAF50;
            font-size: 0.95em;
        }
        
        .profile-id {
            color: #aaa;
            font-size: 0.8em;
            margin-top: 2px;
            font-family: monospace;
        }
        
        .profile-content {
            margin: 10px 0;
            font-size: 0.9em;
            color: #ddd;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 2; /* Limit to 2 lines */
            -webkit-box-orient: vertical;
            flex: 1; /* Takes up remaining space */
        }
        
        .profile-status {
            background: rgba(76, 175, 80, 0.2);
            border: 1px solid #4CAF50;
            color: #4CAF50;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            display: inline-block;
            margin: 8px 0;
        }
        
        .profile-actions {
            display: flex;
            gap: 10px;
            margin-top: auto; /* Pushes buttons to bottom */
        }
        
        /* Image Modal Styles */
        .image-modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            cursor: pointer;
        }
        
        .image-modal-content {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            max-width: 90%;
            max-height: 90%;
            border-radius: 10px;
        }
        
        .image-modal-close {
            position: absolute;
            top: 15px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
        }
        
        .image-modal-close:hover {
            color: #4CAF50;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.9em;
            transition: all 0.3s;
        }
        
        .btn-danger {
            background: #f44336;
            color: white;
        }
        
        .btn-danger:hover {
            background: #d32f2f;
        }
        
        .btn-warning {
            background: #ff9800;
            color: white;
        }
        
        .btn-warning:hover {
            background: #f57c00;
        }
        
        .btn-primary {
            background: #2196F3;
            color: white;
        }
        
        .btn-primary:hover {
            background: #1976D2;
        }
        
        .input-group {
            margin-bottom: 15px;
        }
        
        .input-group label {
            display: block;
            margin-bottom: 5px;
            color: #ccc;
        }
        
        .input-group input, .input-group textarea, .input-group select {
            width: 100%;
            padding: 10px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 5px;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        
        /* FIXED: Better dropdown styling for visibility */
        .input-group select {
            background: rgba(255, 255, 255, 0.15);
            color: #fff;
        }
        
        .input-group select option {
            background: #2c2c54;
            color: #fff;
            padding: 8px;
        }
        
        .input-group select option:hover {
            background: #4CAF50;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: rgba(255, 255, 255, 0.1);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .stat-number {
            font-size: 2em;
            font-weight: bold;
            color: #4CAF50;
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: #ccc;
        }
        
        .error {
            background: rgba(244, 67, 54, 0.2);
            border: 1px solid #f44336;
            color: #f44336;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
        
        .success {
            background: rgba(76, 175, 80, 0.2);
            border: 1px solid #4CAF50;
            color: #4CAF50;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }
        
        .report-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #ff9800;
        }
        
        .report-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .announcement-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #2196F3;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ Character Select+ Admin Dashboard</h1>
            <!-- FIXED: Changed "Manage your" to "Manage" -->
            <p>Manage gallery, announcements, and reports</p>
        </div>
        
        <div class="auth-section">
            <div class="input-group">
                <label for="adminKey">Admin Secret Key:</label>
                <input type="password" id="adminKey" placeholder="Enter your admin secret key">
            </div>
            <button class="btn btn-primary" onclick="loadDashboard()">Load Dashboard</button>
        </div>
        
        <div id="dashboardContent" style="display: none;">
            <div class="stats" id="statsSection">
                <div class="stat-card">
                    <div class="stat-number" id="totalProfiles">-</div>
                    <!-- FIXED: Updated label to be more accurate -->
                    <div>Gallery Profiles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="pendingReports">-</div>
                    <div>Pending Reports</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="totalBanned">-</div>
                    <div>Banned Profiles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="activeAnnouncements">-</div>
                    <div>Active Announcements</div>
                </div>
            </div>
            
            <!-- ENHANCED: Refresh All Button -->
            <div style="text-align: center; margin-bottom: 20px;">
                <button class="btn btn-primary" onclick="refreshStats()" id="refreshBtn">
                    🔄 Refresh All
                </button>
            </div>
            
            <div class="tabs">
                <button class="tab active" onclick="showTab('profiles')">Gallery Profiles</button>
                <button class="tab" onclick="showTab('reports')">Reports</button>
                <button class="tab" onclick="showTab('announcements')">Announcements</button>
                <button class="tab" onclick="showTab('moderation')">Moderation Log</button>
            </div>
            
            <div id="profiles" class="tab-content active">
                <h3>Gallery Profiles</h3>
                <div class="loading" id="profilesLoading">Loading profiles...</div>
                <div class="profile-grid" id="profilesGrid"></div>
            </div>
            
            <div id="reports" class="tab-content">
                <h3>Reports</h3>
                <div class="loading" id="reportsLoading">Loading reports...</div>
                <div id="reportsContainer"></div>
            </div>
            
            <div id="announcements" class="tab-content">
                <h3>Announcements</h3>
                <div class="input-group">
                    <label for="announcementTitle">Title:</label>
                    <input type="text" id="announcementTitle" placeholder="Announcement title">
                </div>
                <div class="input-group">
                    <label for="announcementMessage">Message:</label>
                    <textarea id="announcementMessage" rows="3" placeholder="Announcement message"></textarea>
                </div>
                <div class="input-group">
                    <label for="announcementType">Type:</label>
                    <select id="announcementType">
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="update">Update</option>
                        <option value="maintenance">Maintenance</option>
                    </select>
                </div>
                <button class="btn btn-primary" onclick="createAnnouncement()">Create Announcement</button>
                
                <div class="loading" id="announcementsLoading">Loading announcements...</div>
                <div id="announcementsContainer"></div>
            </div>
            
            <div id="moderation" class="tab-content">
                <h3>Moderation Actions</h3>
                <div class="loading" id="moderationLoading">Loading moderation log...</div>
                <div id="moderationContainer"></div>
            </div>
        </div>
    </div>
    
    <!-- Image Modal for viewing full-size images -->
    <div id="imageModal" class="image-modal" onclick="closeImageModal()">
        <span class="image-modal-close" onclick="closeImageModal()">&times;</span>
        <img class="image-modal-content" id="modalImage">
    </div>

    <script>
        let adminKey = '';
        const serverUrl = window.location.origin;
        
        async function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            
            // Auto-refresh stats when switching tabs
            await refreshStats();
            
            switch(tabName) {
                case 'profiles':
                    loadProfiles();
                    break;
                case 'reports':
                    loadReports();
                    break;
                case 'announcements':
                    loadAnnouncements();
                    break;
                case 'moderation':
                    loadModerationLog();
                    break;
            }
        }
        
        async function loadDashboard() {
            adminKey = document.getElementById('adminKey').value;
            
            if (!adminKey) {
                alert('Please enter your admin key');
                return;
            }
            
            try {
                await refreshStats();
                document.getElementById('dashboardContent').style.display = 'block';
                loadProfiles();
                
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        // ENHANCED: Refresh stats AND current tab content
        async function refreshStats() {
            if (!adminKey) return;
            
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) {
                refreshBtn.textContent = '🔄 Refreshing...';
                refreshBtn.disabled = true;
            }
            
            try {
                // Refresh stats
                const response = await fetch(\`\${serverUrl}/admin/dashboard?adminKey=\${adminKey}\`);
                if (!response.ok) {
                    throw new Error('Failed to load stats');
                }
                
                const stats = await response.json();
                
                document.getElementById('totalProfiles').textContent = stats.totalProfiles;
                document.getElementById('pendingReports').textContent = stats.pendingReports;
                document.getElementById('totalBanned').textContent = stats.totalBanned;
                document.getElementById('activeAnnouncements').textContent = stats.activeAnnouncements;
                
                // Also refresh current tab content
                const activeTab = document.querySelector('.tab.active');
                if (activeTab) {
                    const tabName = activeTab.textContent.toLowerCase().replace(' ', '');
                    switch(tabName) {
                        case 'galleryprofiles':
                            await loadProfiles();
                            break;
                        case 'reports':
                            await loadReports();
                            break;
                        case 'announcements':
                            await loadAnnouncements();
                            break;
                        case 'moderationlog':
                            await loadModerationLog();
                            break;
                    }
                }
                
            } catch (error) {
                console.error('Error refreshing:', error);
            } finally {
                if (refreshBtn) {
                    refreshBtn.textContent = '🔄 Refresh All';
                    refreshBtn.disabled = false;
                }
            }
        }
        
        async function loadProfiles() {
            const loading = document.getElementById('profilesLoading');
            const grid = document.getElementById('profilesGrid');
            
            loading.style.display = 'block';
            grid.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/gallery?admin=true&key=\${adminKey}\`);
                const profiles = await response.json();
                
                loading.style.display = 'none';
                
                profiles.forEach(profile => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    
                    // Create clickable image element or placeholder
                    const imageHtml = profile.ProfileImageUrl 
                        ? \`<img src="\${profile.ProfileImageUrl}" 
                                alt="\${profile.CharacterName}" 
                                class="profile-image" 
                                onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                           <div class="profile-image-placeholder" style="display: none;">🖼️</div>\`
                        : \`<div class="profile-image-placeholder">🖼️</div>\`;
                    
                    // Show either Gallery Status OR Bio (Gallery Status takes priority)
                    let contentHtml = '';
                    if (profile.GalleryStatus && profile.GalleryStatus.trim()) {
                        contentHtml = \`<div class="profile-status">\${profile.GalleryStatus}</div>\`;
                    } else if (profile.Bio && profile.Bio.trim()) {
                        contentHtml = \`<div class="profile-content">\${profile.Bio}</div>\`;
                    } else {
                        contentHtml = \`<div class="profile-content">No bio</div>\`;
                    }
                    
                    card.innerHTML = \`
                        <div class="profile-header">
                            <div class="profile-info">
                                <div class="profile-name">\${profile.CharacterName}</div>
                                <div class="profile-id">\${profile.CharacterId}</div>
                                <div style="margin-top: 8px; display: flex; align-items: center; gap: 10px;">
                                    <span style="color: #ccc; font-size: 0.9em;">\${profile.Server}</span>
                                    <span style="color: #4CAF50;">❤️ \${profile.LikeCount}</span>
                                </div>
                            </div>
                            \${imageHtml}
                        </div>
                        \${contentHtml}
                        <div class="profile-actions">
                            <button class="btn btn-danger" onclick="removeProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                                Remove
                            </button>
                            <button class="btn btn-warning" onclick="banProfile('\${profile.CharacterId}', '\${profile.CharacterName}')">
                                Ban
                            </button>
                        </div>
                    \`;
                    grid.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading profiles: \${error.message}</div>\`;
            }
        }
        
        // Image modal functions
        function openImageModal(imageUrl, characterName) {
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImage');
            modal.style.display = 'block';
            modalImg.src = imageUrl;
            modalImg.alt = characterName;
        }
        
        function closeImageModal() {
            document.getElementById('imageModal').style.display = 'none';
        }
        
        // Close modal when pressing Escape key
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                closeImageModal();
            }
        });
        
        async function removeProfile(characterId, characterName) {
            const reason = prompt(\`Why are you removing \${characterName}?\`);
            if (!reason) return;
            
            const ban = confirm('Also ban this profile from uploading again?');
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}\`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ reason, ban })
                });
                
                if (response.ok) {
                    alert(\`\${characterName} has been removed\${ban ? ' and banned' : ''}\`);
                    loadProfiles();
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error removing profile');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function banProfile(characterId, characterName) {
            const reason = prompt(\`Why are you banning \${characterName}?\`);
            if (!reason) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/ban\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ reason })
                });
                
                if (response.ok) {
                    alert(\`\${characterName} has been banned\`);
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error banning profile');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadReports() {
            const loading = document.getElementById('reportsLoading');
            const container = document.getElementById('reportsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/reports?adminKey=\${adminKey}\`);
                const reports = await response.json();
                
                loading.style.display = 'none';
                
                reports.forEach(report => {
                    const card = document.createElement('div');
                    card.className = 'report-card';
                    card.innerHTML = \`
                        <div class="report-header">
                            <strong>\${report.reportedCharacterName}</strong>
                            <span class="btn btn-\${report.status === 'pending' ? 'warning' : 'primary'}">\${report.status}</span>
                        </div>
                        <p><strong>Reason:</strong> \${report.reason}</p>
                        <p><strong>Details:</strong> \${report.details || 'None'}</p>
                        <p><strong>Reported by:</strong> \${report.reporterCharacter}</p>
                        <p><strong>Date:</strong> \${new Date(report.createdAt).toLocaleDateString()}</p>
                        \${report.status === 'pending' ? \`
                            <div style="margin-top: 10px;">
                                <button class="btn btn-primary" onclick="updateReport('\${report.id}', 'resolved')">Mark Resolved</button>
                                <button class="btn btn-warning" onclick="updateReport('\${report.id}', 'dismissed')">Dismiss</button>
                            </div>
                        \` : ''}
                    \`;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading reports: \${error.message}</div>\`;
            }
        }
        
        async function updateReport(reportId, status) {
            const adminNotes = prompt('Add admin notes (optional):');
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/reports/\${reportId}\`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ status, adminNotes })
                });
                
                if (response.ok) {
                    alert('Report updated');
                    loadReports();
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error updating report');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function createAnnouncement() {
            const title = document.getElementById('announcementTitle').value;
            const message = document.getElementById('announcementMessage').value;
            const type = document.getElementById('announcementType').value;
            
            if (!title || !message) {
                alert('Please fill in title and message');
                return;
            }
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ title, message, type })
                });
                
                if (response.ok) {
                    alert('Announcement created');
                    document.getElementById('announcementTitle').value = '';
                    document.getElementById('announcementMessage').value = '';
                    loadAnnouncements();
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error creating announcement');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadAnnouncements() {
            const loading = document.getElementById('announcementsLoading');
            const container = document.getElementById('announcementsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements?adminKey=\${adminKey}\`);
                const announcements = await response.json();
                
                loading.style.display = 'none';
                
                announcements.forEach(announcement => {
                    const card = document.createElement('div');
                    card.className = 'announcement-card';
                    card.innerHTML = \`
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <strong>\${announcement.title}</strong>
                            <span class="btn btn-\${announcement.active ? 'primary' : 'warning'}">\${announcement.active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <p>\${announcement.message}</p>
                        <p><strong>Type:</strong> \${announcement.type}</p>
                        <p><strong>Created:</strong> \${new Date(announcement.createdAt).toLocaleDateString()}</p>
                        \${announcement.active ? \`
                            <button class="btn btn-warning" onclick="deactivateAnnouncement('\${announcement.id}')">Deactivate</button>
                        \` : ''}
                        <button class="btn btn-danger" onclick="deleteAnnouncement('\${announcement.id}')">Delete</button>
                    \`;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading announcements: \${error.message}</div>\`;
            }
        }
        
        async function deactivateAnnouncement(id) {
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements/\${id}/deactivate\`, {
                    method: 'PATCH',
                    headers: { 'X-Admin-Key': adminKey }
                });
                
                if (response.ok) {
                    loadAnnouncements();
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error deactivating announcement');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function deleteAnnouncement(id) {
            if (!confirm('Are you sure you want to delete this announcement?')) return;
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/announcements/\${id}\`, {
                    method: 'DELETE',
                    headers: { 'X-Admin-Key': adminKey }
                });
                
                if (response.ok) {
                    loadAnnouncements();
                    // Auto-refresh stats after action
                    await refreshStats();
                } else {
                    alert('Error deleting announcement');
                }
            } catch (error) {
                alert(\`Error: \${error.message}\`);
            }
        }
        
        async function loadModerationLog() {
            const loading = document.getElementById('moderationLoading');
            const container = document.getElementById('moderationContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(\`\${serverUrl}/admin/moderation/actions?adminKey=\${adminKey}\`);
                const actions = await response.json();
                
                loading.style.display = 'none';
                
                actions.forEach(action => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.innerHTML = \`
                        <div><strong>\${action.action.toUpperCase()}</strong> - \${action.characterName}</div>
                        <p><strong>Reason:</strong> \${action.reason}</p>
                        <p><strong>Admin:</strong> \${action.adminId}</p>
                        <p><strong>Date:</strong> \${new Date(action.timestamp).toLocaleString()}</p>
                    \`;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = \`<div class="error">Error loading moderation log: \${error.message}</div>\`;
            }
        }
    </script>
</body>
</html>
    `;
    
    res.send(adminHtml);
});

// =============================================================================
// ALL YOUR EXISTING ENDPOINTS (keeping them exactly the same)
// =============================================================================

// Health check
app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "healthy", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Upload endpoints (keeping all existing logic)
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
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            await safeFileMove(req.file.path, finalImagePath);

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        console.log(`✅ Saved profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);
            
            await safeFileMove(req.file.path, finalImagePath);
            
            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        console.log(`✅ PUT updated profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('PUT error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// View endpoint
app.get("/view/:name", async (req, res) => {
    try {
        const requestedName = decodeURIComponent(req.params.name);
        let filePath = path.join(profilesDir, `${requestedName}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                const sanitizedProfile = sanitizeProfileResponse(profile);
                return res.json(sanitizedProfile);
            } catch (err) {
                console.error(`Error reading profile ${requestedName}:`, err.message);
            }
        }

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const matchingProfiles = [];
        const expectedSuffix = `_${requestedName}.json`;

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
        
        const sanitizedProfile = sanitizeProfileResponse(matchingProfiles[0].profile);
        res.json(sanitizedProfile);
    } catch (err) {
        console.error(`Error in view endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// Gallery endpoint
app.get("/gallery", async (req, res) => {
    try {
        const isPlugin = req.headers['x-plugin-auth'] === 'cs-plus-gallery-client';
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;
        
        const now = Date.now();
        if (galleryCache && (now - galleryCacheTime) < CACHE_DURATION) {
            if (isPlugin || isAdmin) {
                return res.json(galleryCache);
            } else {
                return res.json(sanitizeGalleryData(galleryCache));
            }
        }

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const showcaseProfiles = [];
        let skippedFiles = 0;

        for (let i = 0; i < profileFiles.length; i += 10) {
            const batch = profileFiles.slice(i, i + 10);
            
            const batchResults = await Promise.all(batch.map(async (file) => {
                const characterId = file.replace('.json', '');
                const filePath = path.join(profilesDir, file);
                
                try {
                    if (moderationDB.isProfileBanned(characterId)) {
                        return null;
                    }

                    const profileData = await readProfileAsync(filePath);
                    
                    if (!isValidProfile(profileData)) {
                        skippedFiles++;
                        return null;
                    }
                    
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
                            LikeCount: likesDB.getLikeCount(characterId),
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

            batchResults.forEach(result => {
                if (result) showcaseProfiles.push(result);
            });
        }

        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        
        galleryCache = showcaseProfiles;
        galleryCacheTime = now;
        
        if (isPlugin || isAdmin) {
            res.json(showcaseProfiles);
        } else {
            res.json(sanitizeGalleryData(showcaseProfiles));
        }
        
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// Like endpoints
app.post("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.addLike(characterId, likerId);
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but like saved to database:', err);
            }
        }
        
        galleryCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

app.delete("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.removeLike(characterId, likerId);
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but unlike saved to database:', err);
            }
        }
        
        galleryCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Unlike error:', err);
        res.status(500).json({ error: 'Failed to unlike profile' });
    }
});

// Friends endpoints
app.post("/friends/update-follows", async (req, res) => {
    try {
        const { character, following } = req.body;
        
        if (!character || !Array.isArray(following)) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        friendsDB.updateFriends(character, following);
        
        const followsFile = path.join(profilesDir, `${character}_follows.json`);
        const followsData = {
            character: character,
            following: following,
            lastUpdated: new Date().toISOString()
        };
        
        try {
            await atomicWriteProfile(followsFile, followsData);
        } catch (err) {
            console.error('Failed to write friends backup file:', err);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update friends error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post("/friends/check-mutual", async (req, res) => {
    try {
        const { character } = req.body;
        
        if (!character) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        const mutualFriends = friendsDB.getMutualFriends(character);
        res.json({ mutualFriends });
        
    } catch (error) {
        console.error('Check mutual error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// MODERATION ENDPOINTS
// =============================================================================

// Get active announcements (public)
app.get("/announcements", (req, res) => {
    try {
        const announcements = announcementsDB.getActiveAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Create announcement (admin only)
app.post("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const { title, message, type } = req.body;
        
        if (!title || !message) {
            return res.status(400).json({ error: 'Title and message are required' });
        }

        const announcement = announcementsDB.addAnnouncement(title, message, type);
        res.json(announcement);
    } catch (error) {
        console.error('Create announcement error:', error);
        res.status(500).json({ error: 'Failed to create announcement' });
    }
});

// Get all announcements (admin only)
app.get("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const announcements = announcementsDB.getAllAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get all announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Deactivate announcement (admin only)
app.patch("/admin/announcements/:id/deactivate", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deactivateAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Deactivate announcement error:', error);
        res.status(500).json({ error: 'Failed to deactivate announcement' });
    }
});

// Delete announcement (admin only)
app.delete("/admin/announcements/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deleteAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Delete announcement error:', error);
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});

// Submit report (public)
app.post("/reports", (req, res) => {
    try {
        const { reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details } = req.body;
        
        if (!reportedCharacterId || !reporterCharacter || !reason) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const report = reportsDB.addReport(
            reportedCharacterId, 
            reportedCharacterName || reportedCharacterId, 
            reporterCharacter, 
            reason, 
            details
        );
        
        res.json({ success: true, reportId: report.id });
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get reports (admin only)
app.get("/admin/reports", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const reports = reportsDB.getReports(status);
        res.json(reports);
    } catch (error) {
        console.error('Get reports error:', error);
        res.status(500).json({ error: 'Failed to get reports' });
    }
});

// Update report status (admin only)
app.patch("/admin/reports/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const success = reportsDB.updateReportStatus(id, status, adminNotes);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Report not found' });
        }
    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({ error: 'Failed to update report' });
    }
});

// Remove profile (admin only)
app.delete("/admin/profiles/:characterId", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason, ban } = req.body;
        const adminId = req.headers['x-admin-id'] || 'admin';
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        let characterName = characterId;
        try {
            const profile = await readProfileAsync(filePath);
            characterName = profile.CharacterName || characterId;
        } catch (err) {
            // Use characterId as fallback
        }

        // Delete the profile file
        fs.unlinkSync(filePath);
        
        // Remove associated image if exists
        try {
            const imageFiles = fs.readdirSync(imagesDir);
            const associatedImage = imageFiles.find(file => file.startsWith(characterId.replace(/[^\w@\-_.]/g, "_")));
            if (associatedImage) {
                fs.unlinkSync(path.join(imagesDir, associatedImage));
                console.log(`🗑️ Deleted associated image: ${associatedImage}`);
            }
        } catch (err) {
            console.error('Error deleting associated image:', err);
        }

        moderationDB.logAction('remove', characterId, characterName, reason || 'No reason provided', adminId);
        
        if (ban) {
            moderationDB.banProfile(characterId);
            moderationDB.logAction('ban', characterId, characterName, reason || 'No reason provided', adminId);
        }

        galleryCache = null;
        
        console.log(`🛡️ Profile ${characterName} removed by ${adminId}${ban ? ' and banned' : ''}`);
        res.json({ success: true, banned: !!ban });
        
    } catch (error) {
        console.error('Remove profile error:', error);
        res.status(500).json({ error: 'Failed to remove profile' });
    }
});

// Ban profile (admin only)
app.post("/admin/profiles/:characterId/ban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.headers['x-admin-id'] || 'admin';
        
        moderationDB.banProfile(characterId);
        moderationDB.logAction('ban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile ${characterId} banned by ${adminId}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ban profile error:', error);
        res.status(500).json({ error: 'Failed to ban profile' });
    }
});

// Unban profile (admin only)
app.post("/admin/profiles/:characterId/unban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.headers['x-admin-id'] || 'admin';
        
        moderationDB.unbanProfile(characterId);
        moderationDB.logAction('unban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile ${characterId} unbanned by ${adminId}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Unban profile error:', error);
        res.status(500).json({ error: 'Failed to unban profile' });
    }
});

// Get moderation actions (admin only)
app.get("/admin/moderation/actions", requireAdmin, (req, res) => {
    try {
        const actions = moderationDB.getActions();
        res.json(actions);
    } catch (error) {
        console.error('Get moderation actions error:', error);
        res.status(500).json({ error: 'Failed to get moderation actions' });
    }
});

// Get banned profiles (admin only)
app.get("/admin/moderation/banned", requireAdmin, (req, res) => {
    try {
        const bannedProfiles = Array.from(moderationDB.bannedProfiles);
        res.json(bannedProfiles);
    } catch (error) {
        console.error('Get banned profiles error:', error);
        res.status(500).json({ error: 'Failed to get banned profiles' });
    }
});

// FIXED: Admin dashboard endpoint - now counts only showcase profiles
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
    try {
        // Count all profiles
        const allProfiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && !f.endsWith('_follows.json'));
        
        // Count only showcase/public profiles (same logic as gallery)
        let showcaseCount = 0;
        for (const file of allProfiles) {
            try {
                const characterId = file.replace('.json', '');
                if (moderationDB.isProfileBanned(characterId)) continue;
                
                const filePath = path.join(profilesDir, file);
                const profileData = await readProfileAsync(filePath);
                
                if (isValidProfile(profileData) && 
                    (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2)) {
                    showcaseCount++;
                }
            } catch (err) {
                // Skip invalid profiles
                continue;
            }
        }
        
        const stats = {
            totalProfiles: showcaseCount, // Now shows only public profiles
            totalReports: reportsDB.getReports().length,
            pendingReports: reportsDB.getReports('pending').length,
            totalBanned: moderationDB.bannedProfiles.size,
            totalAnnouncements: announcementsDB.getAllAnnouncements().length,
            activeAnnouncements: announcementsDB.getActiveAnnouncements().length,
            recentActions: moderationDB.getActions().slice(0, 10)
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to get dashboard data' });
    }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

process.on('SIGTERM', () => {
    console.log('💤 Server shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
    console.log(`📁 Profiles directory: ${profilesDir}`);
    console.log(`🖼️ Images directory: ${imagesDir}`);
    console.log(`🛡️ Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`💾 Database files: ${likesDbFile}, ${friendsDbFile}, ${announcementsDbFile}, ${reportsDbFile}, ${moderationDbFile}`);
    console.log(`🚀 Features: Gallery, Likes, Friends, Announcements, Reports, Visual Moderation Dashboard`);
    console.log(`🗂️ Using data directory: ${DATA_DIR}`);
    
    if (process.env.ADMIN_SECRET_KEY) {
        console.log(`👑 Admin access enabled - visit /admin to moderate`);
    } else {
        console.log(`⚠️  Admin access disabled - set ADMIN_SECRET_KEY environment variable to enable`);
    }
});
