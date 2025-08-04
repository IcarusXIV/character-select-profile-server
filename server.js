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
console.log(`📁 Using data directory: \${DATA_DIR}`);

// Create directories if they don't exist
const profilesDir = path.join(DATA_DIR, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

// =============================================================================
// 💬 COMMUNICATION SYSTEM ENDPOINTS
// =============================================================================

// Send warning to user (admin only)
app.post("/admin/messages/warning", requireAdmin, async (req, res) => {
    try {
        const { characterId, violationType, reason } = req.body;
        const adminId = req.adminId;
        
        if (!characterId || !violationType) {
            return res.status(400).json({ error: 'Character ID and violation type are required' });
        }

        // Try to get character name from profile
        let characterName = characterId;
        try {
            const filePath = path.join(profilesDir, `\${characterId}.json`);
            if (fs.existsSync(filePath)) {
                const profile = await readProfileAsync(filePath);
                characterName = profile.CharacterName || characterId;
            }
        } catch (err) {
            // Use characterId as fallback
        }

        const message = messagesDB.sendWarning(characterId, characterName, violationType, reason, adminId);
        
        res.json({ 
            success: true, 
            messageId: message.id,
            characterName 
        });
    } catch (error) {
        console.error('Send warning error:', error);
        res.status(500).json({ error: 'Failed to send warning' });
    }
});

// Send notification (admin only)
app.post("/admin/messages/notification", requireAdmin, async (req, res) => {
    try {
        const { characterId, message, type } = req.body;
        const adminId = req.adminId;
        
        if (!characterId || !message) {
            return res.status(400).json({ error: 'Character ID and message are required' });
        }

        let characterName = characterId;
        try {
            const filePath = path.join(profilesDir, `\${characterId}.json`);
            if (fs.existsSync(filePath)) {
                const profile = await readProfileAsync(filePath);
                characterName = profile.CharacterName || characterId;
            }
        } catch (err) {
            // Use characterId as fallback
        }

        const notification = messagesDB.sendNotification(characterId, characterName, type || 'info', message, adminId);
        
        res.json({ 
            success: true, 
            messageId: notification.id,
            characterName 
        });
    } catch (error) {
        console.error('Send notification error:', error);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

// Get all messages (admin only)
app.get("/admin/messages", requireAdmin, (req, res) => {
    try {
        const { type, limit } = req.query;
        let messages = messagesDB.getAllMessages(parseInt(limit) || 100);
        
        if (type) {
            messages = messages.filter(m => m.type === type);
        }
        
        res.json(messages);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// Get messages for specific user (plugin endpoint)
app.get("/messages/:characterId", (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const userKey = req.headers['x-character-key'];
        
        // Basic validation - in real implementation you might want stronger auth
        if (!userKey) {
            return res.status(401).json({ error: 'Character key required' });
        }
        
        const messages = messagesDB.getMessagesForUser(characterId);
        const unreadCount = messagesDB.getUnreadCount(characterId);
        
        res.json({ 
            messages, 
            unreadCount,
            hasNewMessages: unreadCount > 0 
        });
    } catch (error) {
        console.error('Get user messages error:', error);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// Mark message as read (plugin endpoint)
app.patch("/messages/:messageId/read", (req, res) => {
    try {
        const messageId = req.params.messageId;
        const { characterId } = req.body;
        const userKey = req.headers['x-character-key'];
        
        if (!userKey || !characterId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const success = messagesDB.markAsRead(messageId, characterId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Message not found' });
        }
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// =============================================================================
// 🗄️ STORAGE MANAGEMENT ENDPOINTS
// =============================================================================

// Get storage statistics (admin only)
app.get("/admin/storage/stats", requireAdmin, async (req, res) => {
    try {
        // Get cached stats or trigger scan
        const stats = await storageDB.scanStorage();
        res.json(stats);
    } catch (error) {
        console.error('Get storage stats error:', error);
        res.status(500).json({ error: 'Failed to get storage stats' });
    }
});

// Trigger storage scan (admin only)
app.post("/admin/storage/scan", requireAdmin, async (req, res) => {
    try {
        const adminId = req.adminId;
        
        const results = await storageDB.scanStorage();
        
        // Log activity
        activityDB.logActivity('storage', `STORAGE SCAN: \${results.totalImages} images, \${results.orphanedCount} orphaned`, {
            adminId,
            ...results
        });
        
        res.json(results);
    } catch (error) {
        console.error('Storage scan error:', error);
        res.status(500).json({ error: 'Failed to scan storage' });
    }
});

// Cleanup orphaned images (admin only)
app.post("/admin/storage/cleanup-orphaned", requireAdmin, async (req, res) => {
    try {
        const adminId = req.adminId;
        
        const results = await storageDB.cleanupOrphanedImages();
        
        // Log activity
        activityDB.logActivity('storage', `ORPHANED CLEANUP: \${results.cleanedCount} images, \${results.cleanedSizeMB}MB freed`, {
            adminId,
            ...results
        });
        
        res.json(results);
    } catch (error) {
        console.error('Cleanup orphaned error:', error);
        res.status(500).json({ error: 'Failed to cleanup orphaned images' });
    }
});

// Get inactive profiles (admin only)
app.get("/admin/storage/inactive", requireAdmin, (req, res) => {
    try {
        const days = parseInt(req.query.days) || 90;
        const inactiveProfiles = storageDB.getInactiveProfiles(days);
        res.json(inactiveProfiles);
    } catch (error) {
        console.error('Get inactive profiles error:', error);
        res.status(500).json({ error: 'Failed to get inactive profiles' });
    }
});

// Remove profile image only (admin only)
app.delete("/admin/storage/remove-image/:characterId", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const adminId = req.adminId;
        
        const success = await storageDB.removeProfileImage(characterId);
        
        if (success) {
            // Clear gallery cache
            galleryCache = null;
            
            // Log activity
            activityDB.logActivity('storage', `IMAGE REMOVED: \${characterId}`, {
                adminId,
                characterId
            });
            
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Profile or image not found' });
        }
    } catch (error) {
        console.error('Remove image error:', error);
        res.status(500).json({ error: 'Failed to remove image' });
    }
});

// Bulk image cleanup (admin only)
app.post("/admin/storage/bulk-cleanup", requireAdmin, async (req, res) => {
    try {
        const { cleanupOrphaned, cleanupInactive, cleanupLarge } = req.body;
        const adminId = req.adminId;
        
        let totalCleaned = 0;
        let totalSavedMB = 0;
        
        // Cleanup orphaned images
        if (cleanupOrphaned) {
            const orphanedResults = await storageDB.cleanupOrphanedImages();
            totalCleaned += orphanedResults.cleanedCount;
            totalSavedMB += orphanedResults.cleanedSizeMB;
        }
        
        // Cleanup inactive profile images
        if (cleanupInactive) {
            const inactiveProfiles = storageDB.getInactiveProfiles(90);
            for (const profile of inactiveProfiles) {
                if (profile.hasImage) {
                    const success = await storageDB.removeProfileImage(profile.characterId);
                    if (success) {
                        totalCleaned++;
                        totalSavedMB += profile.imageSize / 1024 / 1024;
                    }
                }
            }
        }
        
        // Cleanup large images
        if (cleanupLarge) {
            const imageFiles = fs.readdirSync(imagesDir);
            for (const imageFile of imageFiles) {
                const imagePath = path.join(imagesDir, imageFile);
                const stats = fs.statSync(imagePath);
                
                if (stats.size > 2 * 1024 * 1024) { // 2MB threshold
                    // Find the profile that uses this image
                    const profileFiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && !f.endsWith('_follows.json'));
                    
                    for (const file of profileFiles) {
                        try {
                            const characterId = file.replace('.json', '');
                            const profile = await readProfileAsync(path.join(profilesDir, file));
                            
                            if (profile.ProfileImageUrl && profile.ProfileImageUrl.includes(imageFile)) {
                                const success = await storageDB.removeProfileImage(characterId);
                                if (success) {
                                    totalCleaned++;
                                    totalSavedMB += stats.size / 1024 / 1024;
                                }
                                break;
                            }
                        } catch (err) {
                            // Skip invalid profiles
                        }
                    }
                }
            }
        }
        
        // Clear gallery cache
        galleryCache = null;
        
        // Log activity
        activityDB.logActivity('storage', `BULK CLEANUP: \${totalCleaned} images, \${totalSavedMB.toFixed(2)}MB freed`, {
            adminId,
            cleanupOrphaned,
            cleanupInactive,
            cleanupLarge
        });
        
        res.json({ 
            totalCleaned, 
            totalSavedMB: Math.round(totalSavedMB * 100) / 100 
        });
    } catch (error) {
        console.error('Bulk cleanup error:', error);
        res.status(500).json({ error: 'Failed to perform bulk cleanup' });
    }
});

// Cleanup inactive profiles entirely (admin only)
app.post("/admin/storage/cleanup-inactive", requireAdmin, async (req, res) => {
    try {
        const { daysThreshold, reason } = req.body;
        const adminId = req.adminId;
        
        if (!daysThreshold || !reason) {
            return res.status(400).json({ error: 'Days threshold and reason are required' });
        }

        const inactiveProfiles = storageDB.getInactiveProfiles(daysThreshold);
        let removedCount = 0;
        let freedMB = 0;
        
        for (const profile of inactiveProfiles) {
            try {
                const filePath = path.join(profilesDir, `\${profile.characterId}.json`);
                
                // Delete profile file
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    removedCount++;
                }
                
                // Delete associated image
                if (profile.hasImage) {
                    const success = await storageDB.removeProfileImage(profile.characterId);
                    if (success) {
                        freedMB += profile.imageSize / 1024 / 1024;
                    }
                }
                
                // Log moderation action
                moderationDB.logAction('remove_inactive', profile.characterId, profile.characterName, 
                    `Inactive for \${daysThreshold}+ days: \${reason}`, adminId);
                
            } catch (err) {
                console.error(`Error removing inactive profile \${profile.characterId}:`, err);
            }
        }
        
        // Clear gallery cache
        galleryCache = null;
        
        // Rescan storage
        await storageDB.scanStorage();
        
        res.json({ 
            removedCount, 
            freedMB: Math.round(freedMB * 100) / 100 
        });
    } catch (error) {
        console.error('Cleanup inactive error:', error);
        res.status(500).json({ error: 'Failed to cleanup inactive profiles' });
    }
});

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
const activityDbFile = path.join(DATA_DIR, "activity_database.json");
const flaggedDbFile = path.join(DATA_DIR, "flagged_database.json");
const messagesDbFile = path.join(DATA_DIR, "messages_database.json");
const storageDbFile = path.join(DATA_DIR, "storage_database.json");

// 💾 DATABASE CLASSES (keeping all existing ones)
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
                console.log(`💾 Loaded \${this.likeCounts.size} like records`);
            }
        
        // =============================================================================
        // 💬 COMMUNICATION SYSTEM FUNCTIONS
        // =============================================================================
        
        function showSendWarningModal() {
            const bodyContent = `
                <div class="input-group">
                    <label for="warningCharacterId">Character ID:</label>
                    <input type="text" id="warningCharacterId" class="modal-input" placeholder="Enter character ID to warn">
                </div>
                <div class="input-group">
                    <label for="warningType">Warning Type:</label>
                    <select id="warningType" class="modal-input">
                        <option value="content_violation">Content Violation</option>
                        <option value="spam">Spam Behavior</option>
                        <option value="harassment">Harassment</option>
                        <option value="custom">Custom Message</option>
                    </select>
                </div>
                <div class="input-group">
                    <label for="warningReason">Custom Reason (if applicable):</label>
                    <textarea id="warningReason" class="modal-input modal-textarea" placeholder="Enter custom warning message or additional details"></textarea>
                </div>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-warning" onclick="executeSendWarning()">Send Warning</button>
            `;
            
            showModal('📨 Send Warning', 'Send warning to user', bodyContent, actions);
        }
        
        async function quickWarning(violationType, characterId = null) {
            if (!characterId) {
                characterId = prompt('Enter Character ID to warn:');
                if (!characterId) return;
            }
            
            try {
                const response = await fetch(`\${serverUrl}/admin/messages/warning`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({
                        characterId: characterId.trim(),
                        violationType,
                        reason: ''
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Warning sent to \${result.characterName}\`, 'success');
                    loadMessages();
                } else {
                    const error = await response.json();
                    showToast(\`Error: \${error.error}\`, 'error');
                }
            } catch (error) {
                showToast(\`Error sending warning: \${error.message}\`, 'error');
            }
        }
        
        async function executeSendWarning() {
            const characterId = document.getElementById('warningCharacterId').value.trim();
            const violationType = document.getElementById('warningType').value;
            const reason = document.getElementById('warningReason').value.trim();
            
            if (!characterId) {
                showToast('Character ID is required', 'error');
                return;
            }
            
            closeModal();
            
            try {
                const response = await fetch(`\${serverUrl}/admin/messages/warning`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({
                        characterId,
                        violationType,
                        reason
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Warning sent to \${result.characterName}\`, 'success');
                    loadMessages();
                } else {
                    const error = await response.json();
                    showToast(\`Error: \${error.error}\`, 'error');
                }
            } catch (error) {
                showToast(\`Error sending warning: \${error.message}\`, 'error');
            }
        }
        
        async function loadMessages() {
            const loading = document.getElementById('messagesLoading');
            const container = document.getElementById('messagesContainer');
            const typeFilter = document.getElementById('messageTypeFilter').value;
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                let url = `\${serverUrl}/admin/messages?adminKey=\${adminKey}`;
                if (typeFilter) {
                    url += `&type=\${typeFilter}`;
                }
                
                const response = await fetch(url);
                const messages = await response.json();
                
                loading.style.display = 'none';
                
                if (messages.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px;">💬 No messages to show</div>';
                    return;
                }
                
                messages.forEach(message => {
                    const card = document.createElement('div');
                    const typeColors = {
                        warning: '#ff9800',
                        notification: '#2196F3',
                        chat: '#4CAF50'
                    };
                    
                    card.className = 'profile-card';
                    card.style.borderLeft = `4px solid \${typeColors[message.type] || '#ccc'}`;
                    
                    const timeAgo = getTimeAgo(message.timestamp);
                    const readStatus = message.read ? '✅ Read' : '📬 Unread';
                    
                    card.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <strong>\${message.type.toUpperCase()}: \${message.recipientCharacterName}</strong>
                            <span style="color: \${message.read ? '#4CAF50' : '#ff9800'}; font-size: 0.8em;">\${readStatus}</span>
                        </div>
                        <div style="color: #aaa; font-size: 0.9em; margin-bottom: 8px;">
                            <strong>Subject:</strong> \${message.subject}
                        </div>
                        <div style="background: rgba(0, 0, 0, 0.2); padding: 10px; border-radius: 6px; margin: 10px 0; max-height: 100px; overflow-y: auto;">
                            \${message.content}
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85em; color: #aaa;">
                            <span>From: \${message.fromAdmin}</span>
                            <span>\${timeAgo}</span>
                        </div>
                        \${message.reason ? `<div style="margin-top: 8px; font-size: 0.8em; color: #ccc;"><strong>Reason:</strong> \${message.reason}</div>` : ''}
                    `;
                    
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading messages: \${error.message}</div>`;
            }
        }
        
        // =============================================================================
        // 🗄️ STORAGE MANAGEMENT FUNCTIONS  
        // =============================================================================
        
        async function loadStorageData() {
            const loading = document.getElementById('storageLoading');
            const container = document.getElementById('storageContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                // Load current storage stats
                const response = await fetch(`\${serverUrl}/admin/storage/stats?adminKey=\${adminKey}`);
                const stats = await response.json();
                
                // Update stat cards
                document.getElementById('totalImagesCount').textContent = stats.totalImages || 0;
                document.getElementById('totalStorageSize').textContent = stats.totalSizeMB || 0;
                document.getElementById('orphanedImagesCount').textContent = stats.orphanedCount || 0;
                document.getElementById('inactiveProfilesCount').textContent = stats.inactiveCount || 0;
                
                loading.style.display = 'none';
                
                // Show storage summary
                const summary = document.createElement('div');
                summary.style.cssText = 'background: rgba(255, 255, 255, 0.1); padding: 20px; border-radius: 10px; margin-bottom: 20px;';
                summary.innerHTML = `
                    <h4>📊 Storage Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px;">
                        <div>
                            <strong>Total Storage:</strong><br>
                            <span style="color: #4CAF50;">\${stats.totalSizeMB}MB across \${stats.totalImages} images</span>
                        </div>
                        <div>
                            <strong>Cleanup Potential:</strong><br>
                            <span style="color: #ff9800;">\${stats.orphanedSizeMB}MB in \${stats.orphanedCount} orphaned images</span>
                        </div>
                        <div>
                            <strong>Inactive Profiles:</strong><br>
                            <span style="color: #f44336;">\${stats.inactiveCount} profiles not updated recently</span>
                        </div>
                        <div>
                            <strong>Last Scan:</strong><br>
                            <span style="color: #ccc;">\${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Never'}</span>
                        </div>
                    </div>
                `;
                container.appendChild(summary);
                
                // Show recommendations if needed
                if (stats.orphanedCount > 0 || stats.inactiveCount > 5) {
                    const recommendations = document.createElement('div');
                    recommendations.style.cssText = 'background: rgba(255, 152, 0, 0.1); border: 1px solid #ff9800; padding: 15px; border-radius: 10px; margin-bottom: 20px;';
                    recommendations.innerHTML = `
                        <h4 style="color: #ff9800;">💡 Recommendations</h4>
                        <ul style="margin: 10px 0 0 20px; color: #ddd;">
                            \${stats.orphanedCount > 0 ? `<li>Clean up \${stats.orphanedCount} orphaned images to save \${stats.orphanedSizeMB}MB</li>` : ''}
                            \${stats.inactiveCount > 5 ? `<li>Review \${stats.inactiveCount} inactive profiles for potential cleanup</li>` : ''}
                            \${stats.totalSizeMB > 500 ? '<li>Consider reviewing large images for optimization</li>' : ''}
                        </ul>
                    `;
                    container.appendChild(recommendations);
                }
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading storage data: \${error.message}</div>`;
            }
        }
        
        async function scanStorage() {
            const scanBtn = event.target;
            const originalText = scanBtn.textContent;
            scanBtn.textContent = '🔍 Scanning...';
            scanBtn.disabled = true;
            
            try {
                showToast('Starting storage scan...', 'info');
                
                const response = await fetch(`\${serverUrl}/admin/storage/scan`, {
                    method: 'POST',
                    headers: {
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Scan complete: \${result.totalImages} images, \${result.orphanedCount} orphaned\`, 'success');
                    loadStorageData();
                } else {
                    showToast('Error scanning storage', 'error');
                }
            } catch (error) {
                showToast(\`Scan error: \${error.message}\`, 'error');
            } finally {
                scanBtn.textContent = originalText;
                scanBtn.disabled = false;
            }
        }
        
        async function cleanupOrphanedImages() {
            const bodyContent = `
                <p>This will permanently delete all orphaned images that are no longer referenced by any profiles.</p>
                <p style="color: #ff9800; font-weight: bold;">⚠️ This action cannot be undone!</p>
                <p>Orphaned images are typically created when profiles are deleted but their images remain on the server.</p>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeCleanupOrphaned()">Delete Orphaned Images</button>
            `;
            
            showModal('🗑️ Cleanup Orphaned Images', 'Permanent deletion warning', bodyContent, actions);
        }
        
        async function executeCleanupOrphaned() {
            closeModal();
            
            try {
                showToast('Cleaning up orphaned images...', 'info');
                
                const response = await fetch(`\${serverUrl}/admin/storage/cleanup-orphaned`, {
                    method: 'POST',
                    headers: {
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Cleanup complete: \${result.cleanedCount} images deleted, \${result.cleanedSizeMB}MB freed\`, 'success');
                    loadStorageData();
                } else {
                    showToast('Error cleaning up images', 'error');
                }
            } catch (error) {
                showToast(\`Cleanup error: \${error.message}\`, 'error');
            }
        }
        
        async function loadInactiveProfiles() {
            const threshold = document.getElementById('inactiveThreshold').value;
            
            try {
                const response = await fetch(`\${serverUrl}/admin/storage/inactive?days=\${threshold}&adminKey=\${adminKey}`);
                const inactiveProfiles = await response.json();
                
                const container = document.getElementById('storageContainer');
                const existingSummary = container.querySelector('.storage-summary');
                if (existingSummary) {
                    // Only update the inactive profiles section
                    const inactiveSection = container.querySelector('.inactive-profiles-section');
                    if (inactiveSection) {
                        inactiveSection.remove();
                    }
                } else {
                    // Load full storage data first
                    await loadStorageData();
                }
                
                if (inactiveProfiles.length === 0) {
                    const noInactive = document.createElement('div');
                    noInactive.className = 'inactive-profiles-section';
                    noInactive.style.cssText = 'text-align: center; color: #4CAF50; padding: 20px; background: rgba(76, 175, 80, 0.1); border-radius: 10px; margin-top: 20px;';
                    noInactive.innerHTML = `🎉 No inactive profiles found (\${threshold} days threshold)`;
                    container.appendChild(noInactive);
                    return;
                }
                
                const inactiveSection = document.createElement('div');
                inactiveSection.className = 'inactive-profiles-section';
                inactiveSection.innerHTML = `
                    <h4 style="margin: 20px 0 15px 0;">📋 Inactive Profiles (\${threshold}+ days)</h4>
                    <div style="margin-bottom: 15px;">
                        <button class="btn btn-danger" onclick="showBulkInactiveCleanup(\${threshold})">🧹 Bulk Remove Inactive</button>
                        <span style="margin-left: 15px; color: #ccc;">\${inactiveProfiles.length} profiles found</span>
                    </div>
                `;
                
                const inactiveGrid = document.createElement('div');
                inactiveGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px;';
                
                inactiveProfiles.forEach(profile => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.style.borderLeft = '4px solid #ff9800';
                    card.style.height = 'auto';
                    
                    const daysSince = Math.floor((Date.now() - new Date(profile.lastUpdate).getTime()) / (24 * 60 * 60 * 1000));
                    
                    card.innerHTML = `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: #ff9800;">\${profile.characterName}</strong>
                            <div style="color: #aaa; font-size: 0.85em; font-family: monospace;">\${profile.characterId}</div>
                        </div>
                        <div style="margin: 10px 0;">
                            <div>📅 Last Update: \${daysSince} days ago</div>
                            <div>🖼️ Has Image: \${profile.hasImage ? 'Yes' : 'No'}</div>
                            \${profile.hasImage ? `<div>📏 Image Size: \${(profile.imageSize / 1024).toFixed(1)}KB</div>` : ''}
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 15px;">
                            <button class="btn btn-secondary" onclick="removeProfileImage('\${profile.characterId}', '\${profile.characterName.replace(/'/g, "\\'")}')">Remove Image</button>
                            <button class="btn btn-danger" onclick="initRemoveProfile('\${profile.characterId}', '\${profile.characterName.replace(/'/g, "\\'")}')">Remove Profile</button>
                        </div>
                    `;
                    
                    inactiveGrid.appendChild(card);
                });
                
                inactiveSection.appendChild(inactiveGrid);
                container.appendChild(inactiveSection);
                
            } catch (error) {
                showToast(\`Error loading inactive profiles: \${error.message}\`, 'error');
            }
        }
        
        async function removeProfileImage(characterId, characterName) {
            const bodyContent = `
                <div class="modal-profile-info">
                    <div class="modal-profile-name">\${characterName}</div>
                    <div class="modal-profile-id">\${characterId}</div>
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Remove the profile image from storage</li>
                    <li>Keep the profile active in the gallery</li>
                    <li>User can re-upload an image anytime</li>
                    <li>Free up storage space</li>
                </ul>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-warning" onclick="executeRemoveImage('\${characterId}', '\${characterName.replace(/'/g, "\\'")}')">Remove Image</button>
            `;
            
            showModal('🖼️ Remove Profile Image', 'Keep profile, remove image only', bodyContent, actions);
        }
        
        async function executeRemoveImage(characterId, characterName) {
            closeModal();
            
            try {
                const response = await fetch(`\${serverUrl}/admin/storage/remove-image/\${encodeURIComponent(characterId)}`, {
                    method: 'DELETE',
                    headers: {
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    showToast(\`Image removed from \${characterName}\`, 'success');
                    loadStorageData();
                    loadProfiles(); // Refresh main gallery if visible
                } else {
                    showToast('Error removing image', 'error');
                }
            } catch (error) {
                showToast(\`Error: \${error.message}\`, 'error');
            }
        }
        
        function showBulkImageCleanup() {
            const bodyContent = `
                <h4>🧹 Bulk Image Cleanup Options</h4>
                <div style="margin: 15px 0;">
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="cleanupOrphaned" checked> 
                        Remove all orphaned images
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="cleanupInactive"> 
                        Remove images from profiles inactive for 90+ days
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="cleanupLarge"> 
                        Remove images larger than 2MB (keep profiles)
                    </label>
                </div>
                <p style="color: #ff9800; font-weight: bold;">⚠️ This will permanently delete selected images</p>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeBulkImageCleanup()">Start Cleanup</button>
            `;
            
            showModal('🧹 Bulk Image Cleanup', 'Select cleanup options', bodyContent, actions);
        }
        
        async function executeBulkImageCleanup() {
            const cleanupOrphaned = document.getElementById('cleanupOrphaned').checked;
            const cleanupInactive = document.getElementById('cleanupInactive').checked;
            const cleanupLarge = document.getElementById('cleanupLarge').checked;
            
            if (!cleanupOrphaned && !cleanupInactive && !cleanupLarge) {
                showToast('Please select at least one cleanup option', 'error');
                return;
            }
            
            closeModal();
            
            try {
                showToast('Starting bulk image cleanup...', 'info');
                
                const response = await fetch(`\${serverUrl}/admin/storage/bulk-cleanup`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({
                        cleanupOrphaned,
                        cleanupInactive,
                        cleanupLarge
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Cleanup complete: \${result.totalCleaned} images deleted, \${result.totalSavedMB}MB freed\`, 'success');
                    loadStorageData();
                } else {
                    showToast('Error during bulk cleanup', 'error');
                }
            } catch (error) {
                showToast(\`Cleanup error: \${error.message}\`, 'error');
            }
        }
        
        function showBulkInactiveCleanup(threshold) {
            const bodyContent = `
                <p>Remove all profiles that haven't been updated in <strong>\${threshold}+ days</strong>?</p>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Delete inactive profiles and their images</li>
                    <li>Free up significant storage space</li>
                    <li>Users can re-upload if they return</li>
                </ul>
                <p style="color: #f44336; font-weight: bold;">⚠️ This action cannot be undone!</p>
                <textarea id="bulkInactiveReason" class="modal-input modal-textarea" placeholder="Enter reason for bulk cleanup (required)" required></textarea>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeBulkInactiveCleanup(\${threshold})">Remove Inactive Profiles</button>
            `;
            
            showModal('🧹 Bulk Inactive Cleanup', 'Remove old inactive profiles', bodyContent, actions);
        }
        
        async function executeBulkInactiveCleanup(threshold) {
            const reason = document.getElementById('bulkInactiveReason').value.trim();
            
            if (!reason) {
                showToast('Cleanup reason is required', 'error');
                return;
            }
            
            closeModal();
            
            try {
                showToast(\`Removing profiles inactive for \${threshold}+ days...\`, 'info');
                
                const response = await fetch(`\${serverUrl}/admin/storage/cleanup-inactive`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({
                        daysThreshold: threshold,
                        reason
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    showToast(\`Cleanup complete: \${result.removedCount} profiles deleted, \${result.freedMB}MB freed\`, 'success');
                    loadStorageData();
                    loadProfiles(); // Refresh main gallery
                    refreshStats();
                } else {
                    showToast('Error during inactive cleanup', 'error');
                }
            } catch (error) {
                showToast(\`Cleanup error: \${error.message}\`, 'error');
            }
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

class MessagesDatabase {
    constructor() {
        this.messages = [];
        this.conversations = new Map(); // userId -> [messageIds]
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(messagesDbFile)) {
                const data = JSON.parse(fs.readFileSync(messagesDbFile, 'utf-8'));
                this.messages = data.messages || [];
                this.conversations = new Map(data.conversations || []);
                console.log(`💬 Loaded \${this.messages.length} messages`);
            }
        } catch (err) {
            console.error('Error loading messages database:', err);
            this.messages = [];
            this.conversations = new Map();
        }
    }

    save() {
        try {
            const data = {
                messages: this.messages,
                conversations: Array.from(this.conversations.entries()),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = messagesDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(messagesDbFile)) {
                fs.copyFileSync(messagesDbFile, messagesDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, messagesDbFile);
        } catch (err) {
            console.error('Error saving messages database:', err);
        }
    }

    sendWarning(characterId, characterName, violationType, reason, adminId) {
        const warningTemplates = {
            'content_violation': `Your character "\${characterName}" has been reported for inappropriate content. Please review and update your profile to comply with community guidelines.`,
            'spam': `Your character "\${characterName}" has been flagged for spam-like behavior. Please ensure your content is meaningful and follows community standards.`,
            'harassment': `Your character "\${characterName}" has been reported for harassment. This behavior is not tolerated and may result in a ban.`,
            'custom': reason
        };

        const message = {
            id: crypto.randomUUID(),
            type: 'warning',
            recipientCharacterId: characterId,
            recipientCharacterName: characterName,
            fromAdmin: adminId,
            subject: `Warning: \${violationType.replace('_', ' ').toUpperCase()}`,
            content: warningTemplates[violationType] || warningTemplates['custom'],
            reason: reason,
            timestamp: new Date().toISOString(),
            read: false,
            status: 'sent'
        };

        this.messages.unshift(message);
        
        // Add to user's conversation
        if (!this.conversations.has(characterId)) {
            this.conversations.set(characterId, []);
        }
        this.conversations.get(characterId).unshift(message.id);
        
        this.save();
        
        // Log activity
        activityDB.logActivity('warning', `WARNING SENT: \${characterName}`, {
            messageId: message.id,
            characterId,
            characterName,
            violationType,
            adminId
        });
        
        console.log(`⚠️ Warning sent to \${characterName} by \${adminId}`);
        return message;
    }

    sendNotification(characterId, characterName, type, message, adminId) {
        const notification = {
            id: crypto.randomUUID(),
            type: 'notification',
            recipientCharacterId: characterId,
            recipientCharacterName: characterName,
            fromAdmin: adminId,
            subject: `Profile \${type.charAt(0).toUpperCase() + type.slice(1)}`,
            content: message,
            timestamp: new Date().toISOString(),
            read: false,
            status: 'sent'
        };

        this.messages.unshift(notification);
        
        if (!this.conversations.has(characterId)) {
            this.conversations.set(characterId, []);
        }
        this.conversations.get(characterId).unshift(notification.id);
        
        this.save();
        return notification;
    }

    getMessagesForUser(characterId, limit = 50) {
        const messageIds = this.conversations.get(characterId) || [];
        return messageIds.slice(0, limit).map(id => 
            this.messages.find(m => m.id === id)
        ).filter(Boolean);
    }

    markAsRead(messageId, characterId) {
        const message = this.messages.find(m => m.id === messageId && m.recipientCharacterId === characterId);
        if (message) {
            message.read = true;
            this.save();
            return true;
        }
        return false;
    }

    getAllMessages(limit = 100) {
        return this.messages.slice(0, limit);
    }

    getUnreadCount(characterId) {
        const messageIds = this.conversations.get(characterId) || [];
        return messageIds.reduce((count, id) => {
            const message = this.messages.find(m => m.id === id);
            return count + (message && !message.read ? 1 : 0);
        }, 0);
    }
}

class StorageDatabase {
    constructor() {
        this.storageStats = {
            totalImages: 0,
            totalSize: 0,
            orphanedImages: [],
            lastUpdated: null
        };
        this.imageUsage = new Map(); // imageFile -> { characterId, lastAccessed, size }
        this.inactiveProfiles = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(storageDbFile)) {
                const data = JSON.parse(fs.readFileSync(storageDbFile, 'utf-8'));
                this.storageStats = data.storageStats || this.storageStats;
                this.imageUsage = new Map(data.imageUsage || []);
                this.inactiveProfiles = data.inactiveProfiles || [];
                console.log(`💾 Loaded storage data: \${this.storageStats.totalImages} images`);
            }
        } catch (err) {
            console.error('Error loading storage database:', err);
        }
    }

    save() {
        try {
            const data = {
                storageStats: this.storageStats,
                imageUsage: Array.from(this.imageUsage.entries()),
                inactiveProfiles: this.inactiveProfiles,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = storageDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(storageDbFile)) {
                fs.copyFileSync(storageDbFile, storageDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, storageDbFile);
        } catch (err) {
            console.error('Error saving storage database:', err);
        }
    }

    async scanStorage() {
        try {
            console.log('🔍 Scanning storage...');
            
            // Scan images directory
            const imageFiles = fs.readdirSync(imagesDir);
            let totalSize = 0;
            const orphanedImages = [];
            const currentImages = new Map();

            // Get all profile files
            const profileFiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && !f.endsWith('_follows.json'));
            const activeImages = new Set();

            // Collect all referenced images from profiles
            for (const file of profileFiles) {
                try {
                    const profile = await readProfileAsync(path.join(profilesDir, file));
                    if (profile.ProfileImageUrl) {
                        const imageName = profile.ProfileImageUrl.split('/').pop();
                        activeImages.add(imageName);
                    }
                } catch (err) {
                    // Skip invalid profiles
                }
            }

            // Scan each image file
            for (const imageFile of imageFiles) {
                const imagePath = path.join(imagesDir, imageFile);
                const stats = fs.statSync(imagePath);
                const size = stats.size;
                totalSize += size;

                currentImages.set(imageFile, {
                    size,
                    lastAccessed: stats.atime,
                    lastModified: stats.mtime
                });

                // Check if orphaned
                if (!activeImages.has(imageFile)) {
                    orphanedImages.push({
                        filename: imageFile,
                        size,
                        lastModified: stats.mtime
                    });
                }
            }

            // Find inactive profiles (not updated in X days)
            const inactiveThreshold = 90 * 24 * 60 * 60 * 1000; // 90 days
            const now = Date.now();
            const inactiveProfiles = [];

            for (const file of profileFiles) {
                try {
                    const characterId = file.replace('.json', '');
                    const profile = await readProfileAsync(path.join(profilesDir, file));
                    const lastUpdate = new Date(profile.LastUpdated || profile.LastActiveTime || 0);
                    
                    if (now - lastUpdate.getTime() > inactiveThreshold) {
                        inactiveProfiles.push({
                            characterId,
                            characterName: profile.CharacterName || characterId,
                            lastUpdate: profile.LastUpdated,
                            hasImage: !!profile.ProfileImageUrl,
                            imageSize: profile.ProfileImageUrl ? (currentImages.get(profile.ProfileImageUrl.split('/').pop())?.size || 0) : 0
                        });
                    }
                } catch (err) {
                    // Skip invalid profiles
                }
            }

            this.storageStats = {
                totalImages: imageFiles.length,
                totalSize,
                orphanedImages,
                lastUpdated: new Date().toISOString()
            };

            this.imageUsage = currentImages;
            this.inactiveProfiles = inactiveProfiles;
            this.save();

            console.log(`📊 Storage scan complete: \${imageFiles.length} images, \${(totalSize / 1024 / 1024).toFixed(2)}MB total, \${orphanedImages.length} orphaned`);
            
            return {
                totalImages: imageFiles.length,
                totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
                orphanedCount: orphanedImages.length,
                inactiveCount: inactiveProfiles.length,
                orphanedSizeMB: Math.round(orphanedImages.reduce((sum, img) => sum + img.size, 0) / 1024 / 1024 * 100) / 100
            };
        } catch (err) {
            console.error('Error scanning storage:', err);
            throw err;
        }
    }

    async cleanupOrphanedImages() {
        let cleanedCount = 0;
        let cleanedSize = 0;

        for (const orphan of this.storageStats.orphanedImages) {
            try {
                const imagePath = path.join(imagesDir, orphan.filename);
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                    cleanedCount++;
                    cleanedSize += orphan.size;
                    console.log(`🗑️ Deleted orphaned image: \${orphan.filename}`);
                }
            } catch (err) {
                console.error(`Error deleting \${orphan.filename}:`, err);
            }
        }

        // Update stats
        this.storageStats.totalImages -= cleanedCount;
        this.storageStats.totalSize -= cleanedSize;
        this.storageStats.orphanedImages = [];
        this.save();

        return { cleanedCount, cleanedSizeMB: Math.round(cleanedSize / 1024 / 1024 * 100) / 100 };
    }

    async removeProfileImage(characterId) {
        try {
            const filePath = path.join(profilesDir, `\${characterId}.json`);
            if (!fs.existsSync(filePath)) return false;

            const profile = await readProfileAsync(filePath);
            if (!profile.ProfileImageUrl) return false;

            const imageName = profile.ProfileImageUrl.split('/').pop();
            const imagePath = path.join(imagesDir, imageName);

            // Remove image file
            if (fs.existsSync(imagePath)) {
                const stats = fs.statSync(imagePath);
                fs.unlinkSync(imagePath);
                
                // Update storage stats
                this.storageStats.totalImages--;
                this.storageStats.totalSize -= stats.size;
                
                console.log(`🖼️ Removed image for \${characterId}: \${imageName}`);
            }

            // Update profile
            delete profile.ProfileImageUrl;
            profile.LastUpdated = new Date().toISOString();
            await atomicWriteProfile(filePath, profile);

            this.save();
            return true;
        } catch (err) {
            console.error('Error removing profile image:', err);
            return false;
        }
    }

    getInactiveProfiles(daysThreshold = 90) {
        const threshold = daysThreshold * 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        return this.inactiveProfiles.filter(profile => {
            const lastUpdate = new Date(profile.lastUpdate || 0);
            return now - lastUpdate.getTime() > threshold;
        });
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
                console.log(`🤝 Loaded \${this.friends.size} friend records`);
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
                console.log(`📢 Loaded \${this.announcements.length} announcements`);
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
        console.log(`📢 Added announcement: \${title}`);
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
                console.log(`🚨 Loaded \${this.reports.length} reports`);
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
        console.log(`🚨 New report: \${reportedCharacterName} reported for \${reason}`);
        return report;
    }

    getReports(status = null) {
        if (status) {
            return this.reports.filter(r => r.status === status);
        }
        return this.reports;
    }

    updateReportStatus(reportId, status, adminNotes = null, adminId = 'admin') {
        const report = this.reports.find(r => r.id === reportId);
        if (report) {
            report.status = status;
            report.reviewedAt = new Date().toISOString();
            report.reviewedBy = adminId;
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
                console.log(`🛡️ Loaded \${this.actions.length} moderation actions, \${this.bannedProfiles.size} banned profiles`);
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
        console.log(`🛡️ Moderation: \${action} on \${characterName} by \${adminId}`);
        
        // Log to activity feed
        activityDB.logActivity('moderation', `\${action.toUpperCase()}: \${characterName}`, {
            action,
            characterId,
            characterName,
            adminId,
            reason
        });
        
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

class ActivityDatabase {
    constructor() {
        this.activities = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(activityDbFile)) {
                const data = JSON.parse(fs.readFileSync(activityDbFile, 'utf-8'));
                this.activities = data.activities || [];
                console.log(`📊 Loaded \${this.activities.length} activity entries`);
            }
        } catch (err) {
            console.error('Error loading activity database:', err);
            this.activities = [];
        }
    }

    save() {
        try {
            const data = {
                activities: this.activities.slice(0, 1000), // Keep only latest 1000 entries
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = activityDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(activityDbFile)) {
                fs.copyFileSync(activityDbFile, activityDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, activityDbFile);
        } catch (err) {
            console.error('Error saving activity database:', err);
        }
    }

    logActivity(type, message, metadata = {}) {
        const activity = {
            id: crypto.randomUUID(),
            type, // 'upload', 'like', 'report', 'moderation', 'flag'
            message,
            metadata,
            timestamp: new Date().toISOString()
        };
        
        this.activities.unshift(activity);
        
        // Keep only latest 1000 activities
        if (this.activities.length > 1000) {
            this.activities = this.activities.slice(0, 1000);
        }
        
        this.save();
        return activity;
    }

    getActivities(limit = 50) {
        return this.activities.slice(0, limit);
    }

    getActivitiesByType(type, limit = 50) {
        return this.activities.filter(a => a.type === type).slice(0, limit);
    }
}

class AutoFlaggingDatabase {
    constructor() {
        this.flaggedProfiles = [];
        this.flaggedKeywords = [
            // Racism
            'white power', 'racial purity', 'master race', 'white supremacy',
            // Transphobia  
            'tr*nny', 'tr@nny', 'tranny', 'tr4nny', '41%', 'attack helicopter',
            'real women', 'biological women', 'men in dresses',
            // Homophobia
            'f*ggot', 'f@ggot', 'faggot', 'f4ggot',
            // General hate
            'kill yourself', 'kys', 'rope yourself', 'gas the',
            // Slurs (partial list)
            'n*gger', 'n@gger', 'nigger', 'n1gger'
        ];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(flaggedDbFile)) {
                const data = JSON.parse(fs.readFileSync(flaggedDbFile, 'utf-8'));
                this.flaggedProfiles = data.flaggedProfiles || [];
                this.flaggedKeywords = data.flaggedKeywords || this.flaggedKeywords;
                console.log(`🚩 Loaded \${this.flaggedProfiles.length} flagged profiles`);
            }
        } catch (err) {
            console.error('Error loading flagging database:', err);
            this.flaggedProfiles = [];
        }
    }

    save() {
        try {
            const data = {
                flaggedProfiles: this.flaggedProfiles,
                flaggedKeywords: this.flaggedKeywords,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = flaggedDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(flaggedDbFile)) {
                fs.copyFileSync(flaggedDbFile, flaggedDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, flaggedDbFile);
        } catch (err) {
            console.error('Error saving flagging database:', err);
        }
    }

    scanProfile(characterId, characterName, bio, galleryStatus, tags) {
        const content = `\${bio || ''} \${galleryStatus || ''} \${tags || ''}`.toLowerCase();
        const flaggedKeywords = [];
        
        for (const keyword of this.flaggedKeywords) {
            if (content.includes(keyword.toLowerCase())) {
                flaggedKeywords.push(keyword);
            }
        }
        
        if (flaggedKeywords.length > 0) {
            const flag = {
                id: crypto.randomUUID(),
                characterId,
                characterName,
                content: content.substring(0, 500), // Store first 500 chars for review
                flaggedKeywords,
                status: 'pending',
                flaggedAt: new Date().toISOString(),
                reviewedAt: null,
                reviewedBy: null
            };
            
            this.flaggedProfiles.unshift(flag);
            this.save();
            
            console.log(`🚩 Auto-flagged profile: \${characterName} for keywords: \${flaggedKeywords.join(', ')}`);
            
            // Log to activity feed
            activityDB.logActivity('flag', `AUTO-FLAGGED: \${characterName}`, {
                characterId,
                characterName,
                keywords: flaggedKeywords
            });
            
            return flag;
        }
        
        return null;
    }

    getFlaggedProfiles(status = null) {
        if (status) {
            return this.flaggedProfiles.filter(f => f.status === status);
        }
        return this.flaggedProfiles;
    }

    updateFlagStatus(flagId, status, reviewedBy) {
        const flag = this.flaggedProfiles.find(f => f.id === flagId);
        if (flag) {
            flag.status = status;
            flag.reviewedAt = new Date().toISOString();
            flag.reviewedBy = reviewedBy;
            this.save();
            
            // Log to activity feed
            activityDB.logActivity('moderation', `FLAG \${status.toUpperCase()}: \${flag.characterName}`, {
                flagId,
                characterName: flag.characterName,
                reviewedBy
            });
            
            return true;
        }
        return false;
    }

    addKeyword(keyword) {
        if (!this.flaggedKeywords.includes(keyword.toLowerCase())) {
            this.flaggedKeywords.push(keyword.toLowerCase());
            this.save();
            return true;
        }
        return false;
    }

    removeKeyword(keyword) {
        const index = this.flaggedKeywords.indexOf(keyword.toLowerCase());
        if (index !== -1) {
            this.flaggedKeywords.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

// Initialize databases
const likesDB = new LikesDatabase();
const friendsDB = new FriendsDatabase();
const announcementsDB = new AnnouncementsDatabase();
const reportsDB = new ReportsDatabase();
const moderationDB = new ModerationDatabase();
const activityDB = new ActivityDatabase();
const autoFlagDB = new AutoFlaggingDatabase();
const messagesDB = new MessagesDatabase();
const storageDB = new StorageDatabase();

// Admin authentication middleware
function requireAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    // FIXED: Get admin ID from header, fallback to 'unknown'
    req.adminId = req.headers['x-admin-id'] || req.body.adminId || 'unknown_admin';
    console.log(`🛡️ Admin authenticated: \${req.adminId}`);
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
                    file !== `\${newFileName}.json`
                ));
            });
        });

        const oldVersions = [];
        
        for (const file of allFiles) {
            if (file.endsWith(`_\${physicalCharacterName}.json`)) {
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
        ImageOffset: profile.ImageOffset,
        IsNSFW: profile.IsNSFW || false // Include NSFW flag for client filtering
    }));
}

function sanitizeProfileResponse(profile) {
    const sanitized = { ...profile };
    delete sanitized.CustomImagePath;
    return sanitized;
}

function generateSafeId(characterName, originalId) {
    return characterName.toLowerCase().replace(/\\s+/g, '_') + '_' + 
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
                reject(new Error(`Profile file is empty: \${filePath}`));
                return;
            }
            
            try {
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseError) {
                console.error(`[Error] Invalid JSON in file \${filePath}:`, parseError.message);
                fs.unlink(filePath, (unlinkErr) => {
                    if (!unlinkErr) {
                        console.log(`[Recovery] Deleted corrupted file: \${filePath}`);
                    }
                });
                reject(new Error(`Invalid JSON in profile file: \${filePath}`));
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
// 🖥️ ADMIN DASHBOARD - IMPROVED VERSION WITH PHASE 3 FEATURES
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
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        
        .profile-card {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            height: 240px;
            display: flex;
            flex-direction: column;
            position: relative;
        }
        
        .profile-card.selected {
            border-color: #4CAF50;
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.3);
        }
        
        .bulk-selector {
            position: absolute;
            top: 10px;
            left: 10px;
            width: 20px;
            height: 20px;
            z-index: 10;
        }
        
        .bulk-actions-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, #2c2c54 0%, #40407a 100%);
            padding: 15px 20px;
            border-top: 2px solid #4CAF50;
            box-shadow: 0 -10px 20px rgba(0, 0, 0, 0.3);
            z-index: 100;
            display: none;
            align-items: center;
            gap: 15px;
        }
        
        .bulk-info {
            flex: 1;
            color: #4CAF50;
            font-weight: bold;
        }
        
        .bulk-actions {
            display: flex;
            gap: 10px;
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
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        .nsfw-badge {
            background: rgba(255, 87, 34, 0.2);
            color: #ff5722;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 0.7em;
            border: 1px solid #ff5722;
            white-space: nowrap;
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
            flex: 1;
            overflow-y: auto;
            max-height: 80px;
            padding-right: 5px;
        }
        
        .profile-content::-webkit-scrollbar {
            width: 4px;
        }
        
        .profile-content::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
        }
        
        .profile-content::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 2px;
        }
        
        .profile-content::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }
        
        .gallery-status {
            font-style: italic;
            color: #ddd;
            margin: 4px 0;
            font-size: 0.9em;
        }
        
        .gallery-status:before {
            content: '"';
            color: #4CAF50;
        }
        
        .gallery-status:after {
            content: '"';
            color: #4CAF50;
        }
        
        .profile-actions {
            display: flex;
            gap: 6px;
            margin-top: auto;
            flex-wrap: wrap;
        }
        
        .profile-actions .btn {
            font-size: 0.75em;
            padding: 6px 8px;
            flex: 1;
            min-width: 60px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .btn-nsfw {
            background: #ff5722;
            color: white;
            font-size: 0.75em;
            padding: 6px 8px;
        }
        
        .btn-nsfw:hover {
            background: #d84315;
        }
        
        .btn-nsfw.active {
            background: #d84315;
            box-shadow: 0 0 0 2px rgba(255, 87, 34, 0.3);
        }

        /* Custom Modal System */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1000;
            animation: fadeIn 0.2s ease-out;
        }

        .modal-overlay.show {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @keyframes slideInDown {
            from { 
                opacity: 0;
                transform: translate(-50%, -60%);
            }
            to { 
                opacity: 1;
                transform: translate(-50%, -50%);
            }
        }

        .modal {
            background: linear-gradient(135deg, #2c2c54 0%, #40407a 100%);
            border-radius: 15px;
            padding: 30px;
            max-width: 500px;
            width: 90%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.2);
            position: relative;
            animation: slideInDown 0.3s ease-out;
        }

        .modal-header {
            margin-bottom: 20px;
            text-align: center;
        }

        .modal-title {
            font-size: 1.4em;
            font-weight: bold;
            color: #4CAF50;
            margin-bottom: 10px;
        }

        .modal-subtitle {
            color: #ccc;
            font-size: 0.9em;
        }

        .modal-body {
            margin-bottom: 25px;
        }

        .modal-profile-info {
            background: rgba(255, 255, 255, 0.1);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            border-left: 4px solid #4CAF50;
        }

        .modal-profile-name {
            font-weight: bold;
            color: #4CAF50;
            margin-bottom: 5px;
        }

        .modal-profile-id {
            color: #aaa;
            font-size: 0.85em;
            font-family: monospace;
        }

        .modal-actions {
            display: flex;
            gap: 10px;
            justify-content: center;
            flex-wrap: wrap;
        }

        .modal-input {
            width: 100%;
            padding: 12px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            margin: 10px 0;
            font-size: 0.9em;
        }

        .modal-input:focus {
            outline: none;
            border-color: #4CAF50;
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
        }

        .modal-textarea {
            min-height: 80px;
            resize: vertical;
            font-family: inherit;
        }

        /* Toast Notification System */
        .toast-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2000;
            max-width: 400px;
        }

        .toast {
            background: linear-gradient(135deg, #2c2c54 0%, #40407a 100%);
            border-radius: 10px;
            padding: 15px 20px;
            margin-bottom: 10px;
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
            border-left: 4px solid #4CAF50;
            animation: slideInRight 0.3s ease-out;
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .toast.success {
            border-left-color: #4CAF50;
        }

        .toast.error {
            border-left-color: #f44336;
        }

        .toast.warning {
            border-left-color: #ff9800;
        }

        .toast.info {
            border-left-color: #2196F3;
        }

        @keyframes slideInRight {
            from {
                opacity: 0;
                transform: translateX(100%);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        @keyframes slideOutRight {
            from {
                opacity: 1;
                transform: translateX(0);
            }
            to {
                opacity: 0;
                transform: translateX(100%);
            }
        }

        .toast.removing {
            animation: slideOutRight 0.3s ease-out forwards;
        }

        .toast-header {
            font-weight: bold;
            margin-bottom: 5px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .toast-body {
            color: #ddd;
            font-size: 0.9em;
        }

        .toast-close {
            position: absolute;
            top: 10px;
            right: 15px;
            background: none;
            border: none;
            color: #aaa;
            cursor: pointer;
            font-size: 1.2em;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .toast-close:hover {
            color: #fff;
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
        
        .btn-secondary {
            background: #6c757d;
            color: white;
        }
        
        .btn-secondary:hover {
            background: #5a6268;
        }
        
        .btn-primary {
            background: #2196F3;
            color: white;
        }
        
        .btn-primary:hover {
            background: #1976D2;
        }

        .btn-success {
            background: #4CAF50;
            color: white;
        }
        
        .btn-success:hover {
            background: #45a049;
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
            display: flex;
            gap: 15px;
        }
        
        .report-card.reason-spam {
            border-left-color: #ff5722;
        }
        
        .report-card.reason-inappropriate {
            border-left-color: #f44336;
        }
        
        .report-card.reason-malicious {
            border-left-color: #e91e63;
        }
        
        .report-card.reason-harassment {
            border-left-color: #9c27b0;
        }
        
        .report-card.reason-other {
            border-left-color: #ff9800;
        }
        
        .report-info {
            flex: 1;
        }
        
        .reported-profile {
            width: 140px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 10px;
            text-align: center;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
        }
        
        .reported-profile-image {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            object-fit: cover;
            margin: 0 auto 8px auto;
            border: 2px solid rgba(255, 255, 255, 0.3);
            cursor: pointer;
            transition: all 0.3s;
            display: block;
        }
        
        .reported-profile-image:hover {
            border-color: #4CAF50;
            transform: scale(1.05);
        }
        
        .reported-profile-placeholder {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.1);
            margin: 0 auto 8px auto;
            border: 2px solid rgba(255, 255, 255, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #666;
        }
        
        .reported-profile-name {
            font-size: 0.9em;
            color: #4CAF50;
            font-weight: bold;
            margin-bottom: 4px;
            word-break: break-word;
        }
        
        .reported-profile-server {
            font-size: 0.8em;
            color: #aaa;
            margin-bottom: 8px;
        }
        
        .reported-profile-actions {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: auto;
        }
        
        .reported-profile-actions .btn {
            font-size: 0.7em;
            padding: 4px 6px;
        }
        
        .reason-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: bold;
            margin-bottom: 8px;
            background: rgba(255, 255, 255, 0.1);
            color: #ddd;
            border: 1px solid rgba(255, 255, 255, 0.2);
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
        
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            margin: 20px 0;
            padding: 20px;
        }
        
        .pagination button {
            padding: 8px 12px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .pagination button:hover:not(:disabled) {
            background: rgba(76, 175, 80, 0.3);
            border-color: #4CAF50;
        }
        
        .pagination button.active {
            background: #4CAF50;
            border-color: #4CAF50;
        }
        
        .pagination button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .pagination-info {
            color: #ccc;
            font-size: 0.9em;
        }
        
        /* Activity Feed Styles */
        .activity-item {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 10px;
            border-left: 4px solid #4CAF50;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .activity-item.upload {
            border-left-color: #2196F3;
        }
        
        .activity-item.like {
            border-left-color: #ff5722;
        }
        
        .activity-item.report {
            border-left-color: #ff9800;
        }
        
        .activity-item.moderation {
            border-left-color: #9c27b0;
        }
        
        .activity-item.flag {
            border-left-color: #f44336;
        }
        
        .activity-content {
            flex: 1;
        }
        
        .activity-message {
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .activity-metadata {
            font-size: 0.85em;
            color: #aaa;
        }
        
        .activity-time {
            font-size: 0.8em;
            color: #666;
            white-space: nowrap;
            margin-left: 15px;
        }
        
        /* Advanced Filtering Styles */
        .filter-section {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .filter-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .filter-row {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .filter-controls {
            display: flex;
            gap: 10px;
            justify-content: center;
        }
        
        .filter-active {
            background: rgba(76, 175, 80, 0.2);
            border-color: #4CAF50;
        }
        
        /* Flagged Content Styles */
        .flagged-card {
            background: rgba(244, 67, 54, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #f44336;
        }
        
        .flagged-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .flagged-keywords {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.85em;
            font-family: monospace;
            margin: 5px 5px 5px 0;
            display: inline-block;
        }
        
        .flagged-content {
            background: rgba(0, 0, 0, 0.3);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            font-family: monospace;
            font-size: 0.9em;
            max-height: 100px;
            overflow-y: auto;
        }

        /* Processing indicator */
        .processing {
            pointer-events: none;
            opacity: 0.6;
            position: relative;
        }

        .processing::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 20px;
            height: 20px;
            margin: -10px 0 0 -10px;
            border: 2px solid transparent;
            border-top: 2px solid #4CAF50;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛡️ Character Select+ Admin Dashboard</h1>
            <p>Manage gallery, announcements, and reports</p>
        </div>
        
        <div class="auth-section">
            <div class="input-group">
                <label for="adminKey">Admin Secret Key:</label>
                <input type="password" id="adminKey" placeholder="Enter your admin secret key">
            </div>
            <div class="input-group">
                <label for="adminName">Your Admin Name:</label>
                <input type="text" id="adminName" placeholder="Your name (for moderation logs)" value="">
            </div>
            <button class="btn btn-primary" onclick="loadDashboard()">Load Dashboard</button>
        </div>
        
        <div id="dashboardContent" style="display: none;">
            <div class="stats" id="statsSection">
                <div class="stat-card">
                    <div class="stat-number" id="totalProfiles">-</div>
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
            
            <div style="text-align: center; margin-bottom: 20px;">
                <button class="btn btn-primary" onclick="refreshStats()" id="refreshBtn">
                    🔄 Refresh All
                </button>
            </div>
            
            <div class="tabs">
                <button class="tab active" onclick="showTab('profiles')">Gallery Profiles</button>
                <button class="tab" onclick="showTab('activity')">Activity Feed</button>
                <button class="tab" onclick="showTab('flagged')">Auto-Flagged</button>
                <button class="tab" onclick="showTab('messages')">Communications</button>
                <button class="tab" onclick="showTab('storage')">Storage Management</button>
                <button class="tab" onclick="showTab('announcements')">Announcements</button>
                <button class="tab" onclick="showTab('reports')">Pending Reports</button>
                <button class="tab" onclick="showTab('archived')">Archived Reports</button>
                <button class="tab" onclick="showTab('banned')">Banned Profiles</button>
                <button class="tab" onclick="showTab('moderation')">Moderation Log</button>
            </div>
            
            <div id="profiles" class="tab-content active">
                <h3>Gallery Profiles</h3>
                
                <!-- Advanced Filtering Section -->
                <div class="filter-section">
                    <h4>🔍 Advanced Filters</h4>
                    <div class="filter-grid">
                        <div class="input-group">
                            <label for="profileSearch">Search:</label>
                            <input type="text" id="profileSearch" placeholder="Name, server, bio..." oninput="applyFilters()">
                        </div>
                        <div class="input-group">
                            <label for="serverFilter">Server:</label>
                            <select id="serverFilter" onchange="applyFilters()">
                                <option value="">All Servers</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="nsfwFilter">NSFW Status:</label>
                            <select id="nsfwFilter" onchange="applyFilters()">
                                <option value="">All Profiles</option>
                                <option value="false">Safe Only</option>
                                <option value="true">NSFW Only</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="imageFilter">Has Image:</label>
                            <select id="imageFilter" onchange="applyFilters()">
                                <option value="">All</option>
                                <option value="true">With Image</option>
                                <option value="false">No Image</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="likesFilter">Like Count:</label>
                            <select id="likesFilter" onchange="applyFilters()">
                                <option value="">Any</option>
                                <option value="0">No Likes</option>
                                <option value="1-5">1-5 Likes</option>
                                <option value="6-20">6-20 Likes</option>
                                <option value="21+">21+ Likes</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="sortFilter">Sort By:</label>
                            <select id="sortFilter" onchange="applyFilters()">
                                <option value="likes">Most Liked</option>
                                <option value="newest">Newest First</option>
                                <option value="oldest">Oldest First</option>
                                <option value="name">Name A-Z</option>
                            </select>
                        </div>
                    </div>
                    <div class="filter-controls">
                        <button class="btn btn-primary" onclick="applyFilters()">Apply Filters</button>
                        <button class="btn btn-secondary" onclick="clearFilters()">Clear All</button>
                        <span id="filterResults" style="color: #4CAF50; margin-left: 15px;"></span>
                    </div>
                </div>
                
                <!-- Bulk Actions Bar -->
                <div class="bulk-actions-bar" id="bulkActionsBar">
                    <div class="bulk-info" id="bulkInfo">0 profiles selected</div>
                    <div class="bulk-actions">
                        <button class="btn btn-secondary" onclick="clearSelection()">Clear Selection</button>
                        <button class="btn btn-nsfw" onclick="initBulkNSFW()">Mark Selected as NSFW</button>
                        <button class="btn btn-danger" onclick="initBulkRemove()">Remove Selected</button>
                        <button class="btn btn-warning" onclick="initBulkBan()">Ban Selected</button>
                    </div>
                </div>
                
                <div class="pagination" id="profilesPagination" style="display: none;">
                    <button id="prevPageBtn" onclick="changePage(-1)">Previous</button>
                    <div class="pagination-info">
                        <span id="pageInfo">Page 1 of 1</span>
                        <span id="totalInfo">(0 profiles)</span>
                    </div>
                    <button id="nextPageBtn" onclick="changePage(1)">Next</button>
                </div>
                <div class="loading" id="profilesLoading">Loading profiles...</div>
                <div class="profile-grid" id="profilesGrid"></div>
                <div class="pagination" id="profilesPaginationBottom" style="display: none;">
                    <button onclick="changePage(-1)">Previous</button>
                    <div class="pagination-info">
                        <span id="pageInfoBottom">Page 1 of 1</span>
                    </div>
                    <button onclick="changePage(1)">Next</button>
                </div>
            </div>
            
            <div id="activity" class="tab-content">
                <h3>📊 Activity Feed</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px; align-items: center;">
                    <select id="activityTypeFilter" onchange="loadActivityFeed()">
                        <option value="">All Activity</option>
                        <option value="upload">Profile Uploads</option>
                        <option value="like">Profile Likes</option>
                        <option value="report">Reports</option>
                        <option value="moderation">Moderation Actions</option>
                        <option value="flag">Auto-Flagged Content</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadActivityFeed()" id="refreshActivityBtn">
                        🔄 Refresh
                    </button>
                    <label style="color: #ccc; margin-left: auto;">
                        <input type="checkbox" id="autoRefreshActivity" onchange="toggleAutoRefresh()"> Auto-refresh (30s)
                    </label>
                </div>
                <div class="loading" id="activityLoading">Loading activity...</div>
                <div id="activityContainer"></div>
            </div>
            
            <div id="flagged" class="tab-content">
                <h3>🚩 Auto-Flagged Content</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px; align-items: center;">
                    <select id="flagStatusFilter" onchange="loadFlaggedProfiles()">
                        <option value="pending">Pending Review</option>
                        <option value="">All Flagged</option>
                        <option value="approved">Approved</option>
                        <option value="removed">Removed</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadFlaggedProfiles()">🔄 Refresh</button>
                    <button class="btn btn-secondary" onclick="showKeywordManager()">Manage Keywords</button>
                </div>
                <div class="loading" id="flaggedLoading">Loading flagged content...</div>
                <div id="flaggedContainer"></div>
            </div>
            
            <div id="messages" class="tab-content">
                <h3>💬 Communications</h3>
                <div style="display: flex; gap: 10px; margin-bottom: 20px; align-items: center;">
                    <button class="btn btn-primary" onclick="showSendWarningModal()">📨 Send Warning</button>
                    <button class="btn btn-secondary" onclick="loadMessages()">🔄 Refresh</button>
                    <select id="messageTypeFilter" onchange="loadMessages()">
                        <option value="">All Messages</option>
                        <option value="warning">Warnings</option>
                        <option value="notification">Notifications</option>
                        <option value="chat">Chat Messages</option>
                    </select>
                </div>
                
                <!-- Send Warning Section -->
                <div class="filter-section" style="margin-bottom: 20px;">
                    <h4>📨 Quick Warning Templates</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px;">
                        <button class="btn btn-warning" onclick="quickWarning('content_violation')">🔞 Content Violation</button>
                        <button class="btn btn-warning" onclick="quickWarning('spam')">📧 Spam Behavior</button>
                        <button class="btn btn-warning" onclick="quickWarning('harassment')">⚠️ Harassment</button>
                        <button class="btn btn-secondary" onclick="showSendWarningModal()">✏️ Custom Warning</button>
                    </div>
                </div>
                
                <div class="loading" id="messagesLoading">Loading messages...</div>
                <div id="messagesContainer"></div>
            </div>
            
            <div id="storage" class="tab-content">
                <h3>🗄️ Storage Management</h3>
                
                <!-- Storage Stats -->
                <div class="stats" style="margin-bottom: 20px;">
                    <div class="stat-card">
                        <div class="stat-number" id="totalImagesCount">-</div>
                        <div>Total Images</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number" id="totalStorageSize">-</div>
                        <div>Storage Used (MB)</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number" id="orphanedImagesCount">-</div>
                        <div>Orphaned Images</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number" id="inactiveProfilesCount">-</div>
                        <div>Inactive Profiles</div>
                    </div>
                </div>
                
                <!-- Storage Actions -->
                <div style="display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;">
                    <button class="btn btn-primary" onclick="scanStorage()">🔍 Scan Storage</button>
                    <button class="btn btn-warning" onclick="cleanupOrphanedImages()">🗑️ Clean Orphaned Images</button>
                    <button class="btn btn-secondary" onclick="loadInactiveProfiles()">📋 View Inactive Profiles</button>
                    <button class="btn btn-danger" onclick="showBulkImageCleanup()">🧹 Bulk Image Cleanup</button>
                </div>
                
                <!-- Storage Filters -->
                <div class="filter-section">
                    <h4>📊 Storage Analysis</h4>
                    <div class="filter-grid">
                        <div class="input-group">
                            <label for="inactiveThreshold">Inactive After (days):</label>
                            <select id="inactiveThreshold" onchange="loadInactiveProfiles()">
                                <option value="30">30 days</option>
                                <option value="60">60 days</option>
                                <option value="90" selected>90 days</option>
                                <option value="180">6 months</option>
                                <option value="365">1 year</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label for="sizeFilter">Image Size:</label>
                            <select id="sizeFilter" onchange="filterImages()">
                                <option value="">All Sizes</option>
                                <option value="large">Large (>1MB)</option>
                                <option value="medium">Medium (500KB-1MB)</option>
                                <option value="small">Small (<500KB)</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <div class="loading" id="storageLoading">Loading storage data...</div>
                <div id="storageContainer"></div>
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
            
            <div id="reports" class="tab-content">
                <h3>Pending Reports</h3>
                <div class="loading" id="reportsLoading">Loading reports...</div>
                <div id="reportsContainer"></div>
            </div>
            
            <div id="archived" class="tab-content">
                <h3>Archived Reports</h3>
                <div class="input-group" style="max-width: 400px; margin-bottom: 20px;">
                    <label for="reportSearch">Search by Character Name:</label>
                    <input type="text" id="reportSearch" placeholder="Type character name..." oninput="filterArchivedReports()">
                </div>
                <div class="loading" id="archivedLoading">Loading archived reports...</div>
                <div id="archivedContainer"></div>
            </div>
            
            <div id="banned" class="tab-content">
                <h3>Banned Profiles</h3>
                <div class="loading" id="bannedLoading">Loading banned profiles...</div>
                <div id="bannedContainer"></div>
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

    <!-- Custom Modal System -->
    <div id="modalOverlay" class="modal-overlay" onclick="closeModal(event)">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <div class="modal-title" id="modalTitle">Confirm Action</div>
                <div class="modal-subtitle" id="modalSubtitle"></div>
            </div>
            <div class="modal-body" id="modalBody">
                <!-- Dynamic content will be inserted here -->
            </div>
            <div class="modal-actions" id="modalActions">
                <!-- Dynamic buttons will be inserted here -->
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <script>
        let adminKey = '';
        let adminName = '';
        let allProfiles = [];
        let filteredProfiles = [];
        let currentPage = 1;
        const profilesPerPage = 24;
        const serverUrl = window.location.origin;
        let activityRefreshInterval = null;
        let availableServers = new Set();
        let selectedProfiles = new Set(); // For bulk actions
        
        // Toast notification system
        function showToast(message, type = 'info', duration = 4000) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = \`toast \\${type}\`;
            
            const icons = {
                success: '✅',
                error: '❌',
                warning: '⚠️',
                info: 'ℹ️'
            };
            
            toast.innerHTML = \`
                <div class="toast-header">
                    \\${icons[type] || 'ℹ️'} \\${type.charAt(0).toUpperCase() + type.slice(1)}
                </div>
                <div class="toast-body">\\${message}</div>
                <button class="toast-close" onclick="removeToast(this.parentElement)">&times;</button>
            \`;
            
            container.appendChild(toast);
            
            // Auto-remove after duration
            setTimeout(() => {
                removeToast(toast);
            }, duration);
            
            return toast;
        }
        
        function removeToast(toast) {
            if (!toast || !toast.parentElement) return;
            
            toast.classList.add('removing');
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.parentElement.removeChild(toast);
                }
            }, 300);
        }
        
        // Custom modal system
        function showModal(title, subtitle, bodyContent, actions) {
            const overlay = document.getElementById('modalOverlay');
            const modalTitle = document.getElementById('modalTitle');
            const modalSubtitle = document.getElementById('modalSubtitle');
            const modalBody = document.getElementById('modalBody');
            const modalActions = document.getElementById('modalActions');
            
            modalTitle.textContent = title;
            modalSubtitle.textContent = subtitle || '';
            modalBody.innerHTML = bodyContent;
            modalActions.innerHTML = actions;
            
            overlay.classList.add('show');
            
            // Focus first input if exists
            const firstInput = modalBody.querySelector('input, textarea');
            if (firstInput) {
                setTimeout(() => firstInput.focus(), 100);
            }
        }
        
        function closeModal(event) {
            if (event && event.target !== event.currentTarget) return;
            const overlay = document.getElementById('modalOverlay');
            overlay.classList.remove('show');
        }
        
        // Custom confirmation modal
        function confirmAction(title, message, onConfirm, onCancel = null, confirmText = 'Confirm', cancelText = 'Cancel') {
            const actions = \`
                <button class="btn btn-secondary" onclick="closeModal(); \\${onCancel ? onCancel + '()' : ''}">\\${cancelText}</button>
                <button class="btn btn-danger" onclick="closeModal(); \\${onConfirm}()">\\${confirmText}</button>
            \`;
            
            showModal(title, '', \`<p>\\${message}</p>\`, actions);
        }
        
        // Custom input modal
        function promptAction(title, message, placeholder, onConfirm, required = true) {
            const inputId = 'modalInput_' + Date.now();
            const bodyContent = \`
                <p>\\${message}</p>
                <input type="text" id="\\${inputId}" class="modal-input" placeholder="\\${placeholder}" \\${required ? 'required' : ''}>
            \`;
            
            const actions = \`
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="handlePromptConfirm('\\${inputId}', '\\${onConfirm}')">Continue</button>
            \`;
            
            showModal(title, '', bodyContent, actions);
        }
        
        function handlePromptConfirm(inputId, callback) {
            const input = document.getElementById(inputId);
            const value = input ? input.value.trim() : '';
            
            if (!value) {
                showToast('Input is required', 'error');
                return;
            }
            
            closeModal();
            
            // Execute callback with the value
            if (typeof window[callback] === 'function') {
                window[callback](value);
            }
        }

        // Bulk Actions System
        function toggleProfileSelection(characterId, checkbox) {
            if (checkbox.checked) {
                selectedProfiles.add(characterId);
            } else {
                selectedProfiles.delete(characterId);
            }
            
            updateBulkActionsBar();
            updateProfileCardSelection(characterId, checkbox.checked);
        }
        
        function updateProfileCardSelection(characterId, selected) {
            const cards = document.querySelectorAll('.profile-card');
            cards.forEach(card => {
                const cardCheckbox = card.querySelector('.bulk-selector');
                if (cardCheckbox && cardCheckbox.dataset.characterId === characterId) {
                    if (selected) {
                        card.classList.add('selected');
                    } else {
                        card.classList.remove('selected');
                    }
                }
            });
        }
        
        function updateBulkActionsBar() {
            const bar = document.getElementById('bulkActionsBar');
            const info = document.getElementById('bulkInfo');
            const count = selectedProfiles.size;
            
            if (count > 0) {
                bar.style.display = 'flex';
                info.textContent = \`\\${count} profile\\${count === 1 ? '' : 's'} selected\`;
            } else {
                bar.style.display = 'none';
            }
        }
        
        function clearSelection() {
            selectedProfiles.clear();
            updateBulkActionsBar();
            
            // Update UI
            document.querySelectorAll('.profile-card.selected').forEach(card => {
                card.classList.remove('selected');
            });
            document.querySelectorAll('.bulk-selector').forEach(checkbox => {
                checkbox.checked = false;
            });
        }
        
        function initBulkNSFW() {
            if (selectedProfiles.size === 0) return;
            
            // Filter out already NSFW profiles
            const eligibleProfiles = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile && !profile.IsNSFW) {
                    eligibleProfiles.push(profile);
                }
            });
            
            if (eligibleProfiles.length === 0) {
                showToast('No eligible profiles (already NSFW or not found)', 'warning');
                return;
            }
            
            const profileNames = eligibleProfiles.slice(0, 5).map(p => p.CharacterName).join(', ');
            const extraCount = eligibleProfiles.length - 5;
            const displayText = extraCount > 0 ? \`\\${profileNames} and \\${extraCount} more\` : profileNames;
            
            const bodyContent = \`
                <p><strong>Mark \\${eligibleProfiles.length} profile\\${eligibleProfiles.length === 1 ? '' : 's'} as NSFW:</strong></p>
                <div style="background: rgba(255, 255, 255, 0.1); padding: 10px; border-radius: 8px; margin: 10px 0; max-height: 100px; overflow-y: auto;">
                    \\${displayText}
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Mark profiles as NSFW content</li>
                    <li>Hide them from safe browsing users</li>
                    <li>Add 🔞 NSFW badges</li>
                    <li>Cannot be undone (use Remove if needed)</li>
                </ul>
                <p style="color: #ff9800; font-weight: bold;">⚠️ Confirm these profiles contain adult content</p>
            \`;
            
            const actions = \`
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-nsfw" onclick="executeBulkNSFW()">Mark \\${eligibleProfiles.length} as NSFW</button>
            \`;
            
            showModal('🔞 Bulk Mark as NSFW', 'Adult content classification', bodyContent, actions);
        }
        
        async function executeBulkNSFW() {
            closeModal();
            
            const eligibleProfiles = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile && !profile.IsNSFW) {
                    eligibleProfiles.push(profile);
                }
            });
            
            let successCount = 0;
            let errorCount = 0;
            
            showToast(\`Starting bulk NSFW marking for \\${eligibleProfiles.length} profiles...\\`, 'info');
            
            for (const profile of eligibleProfiles) {
                try {
                    const response = await fetch(\`\\${serverUrl}/admin/profiles/\\${encodeURIComponent(profile.CharacterId)}/nsfw\`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Key': adminKey
                        },
                        body: JSON.stringify({ isNSFW: true })
                    });
                    
                    if (response.ok) {
                        successCount++;
                        // Update in local data
                        const profileIndex = allProfiles.findIndex(p => p.CharacterId === profile.CharacterId);
                        if (profileIndex !== -1) {
                            allProfiles[profileIndex].IsNSFW = true;
                        }
                    } else {
                        errorCount++;
                    }
                } catch (error) {
                    errorCount++;
                }
            }
            
            clearSelection();
            applyFilters(); // Re-render with updated data
            
            if (successCount > 0) {
                showToast(\`✅ \\${successCount} profile\\${successCount === 1 ? '' : 's'} marked as NSFW\\`, 'success');
            }
            if (errorCount > 0) {
                showToast(\`❌ \\${errorCount} profile\\${errorCount === 1 ? '' : 's'} failed to update\\`, 'error');
            }
        }
        
        function initBulkRemove() {
            if (selectedProfiles.size === 0) return;
            
            const selectedProfileData = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile) {
                    selectedProfileData.push(profile);
                }
            });
            
            const profileNames = selectedProfileData.slice(0, 5).map(p => p.CharacterName).join(', ');
            const extraCount = selectedProfileData.length - 5;
            const displayText = extraCount > 0 ? \`\\${profileNames} and \\${extraCount} more\` : profileNames;
            
            const bodyContent = \`
                <p><strong>Remove \\${selectedProfileData.length} profile\\${selectedProfileData.length === 1 ? '' : 's'} from gallery:</strong></p>
                <div style="background: rgba(255, 255, 255, 0.1); padding: 10px; border-radius: 8px; margin: 10px 0; max-height: 100px; overflow-y: auto;">
                    \\${displayText}
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Remove profiles from the gallery</li>
                    <li>Delete profile images</li>
                    <li>They can still upload new profiles unless banned separately</li>
                </ul>
                <textarea id="bulkRemoveReason" class="modal-input modal-textarea" placeholder="Enter reason for bulk removal (required for moderation logs)" required></textarea>
            \`;
            
            const actions = \`
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeBulkRemove()">Remove \\${selectedProfileData.length} Profile\\${selectedProfileData.length === 1 ? '' : 's'}</button>
            \`;
            
            showModal('🗑️ Bulk Remove Profiles', 'This action cannot be undone', bodyContent, actions);
        }
        
        async function executeBulkRemove() {
            const reason = document.getElementById('bulkRemoveReason').value.trim();
            
            if (!reason) {
                showToast('Removal reason is required', 'error');
                return;
            }
            
            closeModal();
            
            const selectedProfileData = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile) {
                    selectedProfileData.push(profile);
                }
            });
            
            let successCount = 0;
            let errorCount = 0;
            
            showToast(\`Starting bulk removal for \\${selectedProfileData.length} profiles...\\`, 'info');
            
            for (const profile of selectedProfileData) {
                try {
                    const response = await fetch(\`\\${serverUrl}/admin/profiles/\\${encodeURIComponent(profile.CharacterId)}\`, {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Key': adminKey,
                            'X-Admin-Id': adminName
                        },
                        body: JSON.stringify({ reason, ban: false, adminId: adminName })
                    });
                    
                    if (response.ok) {
                        successCount++;
                        // Remove from local data
                        allProfiles = allProfiles.filter(p => p.CharacterId !== profile.CharacterId);
                        filteredProfiles = filteredProfiles.filter(p => p.CharacterId !== profile.CharacterId);
                    } else {
                        errorCount++;
                    }
                } catch (error) {
                    errorCount++;
                }
            }
            
            clearSelection();
            renderProfilesPage(); // Re-render without removed profiles
            refreshStats();
            
            if (successCount > 0) {
                showToast(\`✅ \\${successCount} profile\\${successCount === 1 ? '' : 's'} removed\\`, 'success');
            }
            if (errorCount > 0) {
                showToast(\`❌ \\${errorCount} profile\\${errorCount === 1 ? '' : 's'} failed to remove\\`, 'error');
            }
        }
        
        function initBulkBan() {
            if (selectedProfiles.size === 0) return;
            
            const selectedProfileData = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile) {
                    selectedProfileData.push(profile);
                }
            });
            
            const profileNames = selectedProfileData.slice(0, 5).map(p => p.CharacterName).join(', ');
            const extraCount = selectedProfileData.length - 5;
            const displayText = extraCount > 0 ? \`\\${profileNames} and \\${extraCount} more\` : profileNames;
            
            const bodyContent = \`
                <p><strong>Ban \\${selectedProfileData.length} profile\\${selectedProfileData.length === 1 ? '' : 's'}:</strong></p>
                <div style="background: rgba(255, 255, 255, 0.1); padding: 10px; border-radius: 8px; margin: 10px 0; max-height: 100px; overflow-y: auto;">
                    \\${displayText}
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Permanently ban them from uploading any profiles</li>
                    <li>Current profiles will remain unless removed separately</li>
                    <li>Bans can be lifted later if needed</li>
                </ul>
                <textarea id="bulkBanReason" class="modal-input modal-textarea" placeholder="Enter reason for bulk ban (required for moderation logs)" required></textarea>
            \`;
            
            const actions = \`
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-warning" onclick="executeBulkBan()">Ban \\${selectedProfileData.length} Profile\\${selectedProfileData.length === 1 ? '' : 's'}</button>
            \`;
            
            showModal('🚫 Bulk Ban Profiles', 'Prevent future uploads', bodyContent, actions);
        }
        
        async function executeBulkBan() {
            const reason = document.getElementById('bulkBanReason').value.trim();
            
            if (!reason) {
                showToast('Ban reason is required', 'error');
                return;
            }
            
            closeModal();
            
            const selectedProfileData = [];
            selectedProfiles.forEach(characterId => {
                const profile = allProfiles.find(p => p.CharacterId === characterId);
                if (profile) {
                    selectedProfileData.push(profile);
                }
            });
            
            let successCount = 0;
            let errorCount = 0;
            
            showToast(\`Starting bulk ban for \${selectedProfileData.length} profiles...\`, 'info');
            
            for (const profile of selectedProfileData) {
                try {
                    const response = await fetch(`\${serverUrl}/admin/profiles/\${encodeURIComponent(profile.CharacterId)}/ban`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Key': adminKey,
                            'X-Admin-Id': adminName
                        },
                        body: JSON.stringify({ reason, adminId: adminName })
                    });
                    
                    if (response.ok) {
                        successCount++;
                    } else {
                        errorCount++;
                    }
                } catch (error) {
                    errorCount++;
                }
            }
            
            clearSelection();
            refreshStats();
            
            if (successCount > 0) {
                showToast(\`✅ \${successCount} profile\${successCount === 1 ? '' : 's'} banned\`, 'success');
            }
            if (errorCount > 0) {
                showToast(\`❌ \${errorCount} profile\${errorCount === 1 ? '' : 's'} failed to ban\`, 'error');
            }
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                closeImageModal();
                closeModal();
            }
        });
        
        // Load saved admin credentials on page load
        document.addEventListener('DOMContentLoaded', function() {
            console.log('🔄 Page loaded, checking for saved credentials...');
            
            try {
                const savedAdminKey = localStorage.getItem('cs_admin_key');
                const savedAdminName = localStorage.getItem('cs_admin_name');
                
                console.log('📋 Saved credentials:', savedAdminKey ? 'Key found' : 'No key', savedAdminName ? 'Name found' : 'No name');
                
                if (savedAdminKey) {
                    document.getElementById('adminKey').value = savedAdminKey;
                    adminKey = savedAdminKey;
                }
                
                if (savedAdminName) {
                    document.getElementById('adminName').value = savedAdminName;
                    adminName = savedAdminName;
                }
                
                // Auto-load dashboard if both credentials are saved
                if (savedAdminKey && savedAdminName) {
                    console.log('🚀 Auto-loading dashboard with saved credentials...');
                    setTimeout(() => {
                        autoLoadDashboard();
                    }, 100);
                }
            } catch (e) {
                console.error('❌ Error loading saved credentials:', e);
            }
        });
        
        async function autoLoadDashboard() {
            try {
                const testResponse = await fetch(`\${serverUrl}/admin/dashboard?adminKey=\${adminKey}`);
                
                if (!testResponse.ok) {
                    throw new Error('Invalid saved credentials');
                }
                
                console.log('✅ Saved credentials valid, loading dashboard...');
                await refreshStats();
                document.getElementById('dashboardContent').style.display = 'block';
                document.querySelector('.auth-section').style.display = 'none';
                loadProfiles();
                console.log('🎉 Dashboard auto-loaded successfully');
                
            } catch (error) {
                console.error('❌ Auto-load failed:', error);
                localStorage.removeItem('cs_admin_key');
                localStorage.removeItem('cs_admin_name');
                adminKey = '';
                adminName = '';
                document.getElementById('adminKey').value = '';
                document.getElementById('adminName').value = '';
                showToast('Saved credentials expired. Please log in again.', 'error');
            }
        }
        
        function applyFilters() {
            const searchTerm = document.getElementById('profileSearch').value.toLowerCase();
            const serverFilter = document.getElementById('serverFilter').value;
            const nsfwFilter = document.getElementById('nsfwFilter').value;
            const imageFilter = document.getElementById('imageFilter').value;
            const likesFilter = document.getElementById('likesFilter').value;
            const sortFilter = document.getElementById('sortFilter').value;
            
            let filtered = [...allProfiles];
            
            // Apply search filter
            if (searchTerm) {
                filtered = filtered.filter(profile =>
                    profile.CharacterName.toLowerCase().includes(searchTerm) ||
                    profile.Server.toLowerCase().includes(searchTerm) ||
                    profile.CharacterId.toLowerCase().includes(searchTerm) ||
                    (profile.Bio && profile.Bio.toLowerCase().includes(searchTerm)) ||
                    (profile.GalleryStatus && profile.GalleryStatus.toLowerCase().includes(searchTerm)) ||
                    (profile.Race && profile.Race.toLowerCase().includes(searchTerm)) ||
                    (profile.Tags && profile.Tags.toLowerCase().includes(searchTerm))
                );
            }
            
            // Apply server filter
            if (serverFilter) {
                filtered = filtered.filter(profile => profile.Server === serverFilter);
            }
            
            // Apply NSFW filter
            if (nsfwFilter !== '') {
                const isNSFW = nsfwFilter === 'true';
                filtered = filtered.filter(profile => !!profile.IsNSFW === isNSFW);
            }
            
            // Apply image filter
            if (imageFilter !== '') {
                const hasImage = imageFilter === 'true';
                filtered = filtered.filter(profile => !!profile.ProfileImageUrl === hasImage);
            }
            
            // Apply likes filter
            if (likesFilter) {
                switch(likesFilter) {
                    case '0':
                        filtered = filtered.filter(profile => profile.LikeCount === 0);
                        break;
                    case '1-5':
                        filtered = filtered.filter(profile => profile.LikeCount >= 1 && profile.LikeCount <= 5);
                        break;
                    case '6-20':
                        filtered = filtered.filter(profile => profile.LikeCount >= 6 && profile.LikeCount <= 20);
                        break;
                    case '21+':
                        filtered = filtered.filter(profile => profile.LikeCount >= 21);
                        break;
                }
            }
            
            // Apply sorting
            switch(sortFilter) {
                case 'likes':
                    filtered.sort((a, b) => b.LikeCount - a.LikeCount);
                    break;
                case 'newest':
                    filtered.sort((a, b) => new Date(b.LastUpdated) - new Date(a.LastUpdated));
                    break;
                case 'oldest':
                    filtered.sort((a, b) => new Date(a.LastUpdated) - new Date(b.LastUpdated));
                    break;
                case 'name':
                    filtered.sort((a, b) => a.CharacterName.localeCompare(b.CharacterName));
                    break;
            }
            
            filteredProfiles = filtered;
            currentPage = 1;
            
            document.getElementById('filterResults').textContent = `\${filtered.length} profiles found`;
            
            renderProfilesPage();
        }
        
        function clearFilters() {
            document.getElementById('profileSearch').value = '';
            document.getElementById('serverFilter').value = '';
            document.getElementById('nsfwFilter').value = '';
            document.getElementById('imageFilter').value = '';
            document.getElementById('likesFilter').value = '';
            document.getElementById('sortFilter').value = 'likes';
            
            localStorage.removeItem('cs_admin_filters');
            localStorage.removeItem('cs_admin_current_page');
            
            applyFilters();
        }
        
        function populateServerDropdown() {
            const serverSelect = document.getElementById('serverFilter');
            const currentValue = serverSelect.value;
            
            serverSelect.innerHTML = '<option value="">All Servers</option>';
            
            const sortedServers = Array.from(availableServers).sort();
            sortedServers.forEach(server => {
                const option = document.createElement('option');
                option.value = server;
                option.textContent = server;
                serverSelect.appendChild(option);
            });
            
            if (sortedServers.includes(currentValue)) {
                serverSelect.value = currentValue;
            }
        }
        
        function renderProfilesPage() {
            const startIndex = (currentPage - 1) * profilesPerPage;
            const endIndex = startIndex + profilesPerPage;
            const pageProfiles = filteredProfiles.slice(startIndex, endIndex);
            
            renderProfileCards(pageProfiles);
            updatePaginationControls();
        }
        
        function updatePaginationControls() {
            const totalPages = Math.ceil(filteredProfiles.length / profilesPerPage);
            const pagination = document.getElementById('profilesPagination');
            const paginationBottom = document.getElementById('profilesPaginationBottom');
            
            if (totalPages <= 1) {
                pagination.style.display = 'none';
                paginationBottom.style.display = 'none';
                return;
            }
            
            pagination.style.display = 'flex';
            paginationBottom.style.display = 'flex';
            
            document.getElementById('pageInfo').textContent = `Page \${currentPage} of \${totalPages}`;
            document.getElementById('pageInfoBottom').textContent = `Page \${currentPage} of \${totalPages}`;
            document.getElementById('totalInfo').textContent = `(\${filteredProfiles.length} profiles)`;
            
            const prevButtons = [document.getElementById('prevPageBtn'), paginationBottom.querySelector('button:first-child')];
            const nextButtons = [document.getElementById('nextPageBtn'), paginationBottom.querySelector('button:last-child')];
            
            prevButtons.forEach(btn => {
                btn.disabled = currentPage === 1;
            });
            
            nextButtons.forEach(btn => {
                btn.disabled = currentPage === totalPages;
            });
        }
        
        function changePage(direction) {
            const totalPages = Math.ceil(filteredProfiles.length / profilesPerPage);
            const newPage = currentPage + direction;
            
            if (newPage >= 1 && newPage <= totalPages) {
                currentPage = newPage;
                localStorage.setItem('cs_admin_current_page', currentPage);
                renderProfilesPage();
            }
        }
        
        function renderProfileCards(profiles) {
            const grid = document.getElementById('profilesGrid');
            grid.innerHTML = '';
            
            profiles.forEach(profile => {
                const card = document.createElement('div');
                card.className = 'profile-card';
                if (selectedProfiles.has(profile.CharacterId)) {
                    card.classList.add('selected');
                }
                
                const imageHtml = profile.ProfileImageUrl 
                    ? `<img src="\${profile.ProfileImageUrl}" 
                            alt="\${profile.CharacterName}" 
                            class="profile-image" 
                            onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                            onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                       <div class="profile-image-placeholder" style="display: none;">🖼️</div>`
                    : `<div class="profile-image-placeholder">🖼️</div>`;
                
                const characterNameHtml = `
                    <div class="profile-name">
                        \${profile.CharacterName}
                        \${profile.IsNSFW ? '<span class="nsfw-badge">🔞 NSFW</span>' : ''}
                    </div>
                `;
                
                let contentHtml = '';
                if (profile.GalleryStatus && profile.GalleryStatus.trim()) {
                    contentHtml = `<div class="gallery-status">\${profile.GalleryStatus}</div>`;
                } else if (profile.Bio && profile.Bio.trim()) {
                    contentHtml = `<div class="profile-content">\${profile.Bio}</div>`;
                } else {
                    contentHtml = `<div class="profile-content" style="color: #999; font-style: italic;">No bio</div>`;
                }
                
                const actionButtons = profile.IsNSFW ? `
                    <button class="btn btn-warning" onclick="quickWarning('content_violation', '\${profile.CharacterId}')">⚠️ Warn</button>
                    <button class="btn btn-danger" onclick="initRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                        Remove
                    </button>
                    <button class="btn btn-warning" onclick="initBanProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                        Ban
                    </button>
                ` : `
                    <button class="btn btn-warning" onclick="quickWarning('content_violation', '\${profile.CharacterId}')">⚠️ Warn</button>
                    <button class="btn btn-danger" onclick="initRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                        Remove
                    </button>
                    <button class="btn btn-warning" onclick="initBanProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                        Ban
                    </button>
                    <button class="btn btn-nsfw" onclick="initMarkNSFW('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                        Mark NSFW
                    </button>
                `;
                
                card.innerHTML = `
                    <input type="checkbox" class="bulk-selector" 
                           data-character-id="\${profile.CharacterId}"
                           \${selectedProfiles.has(profile.CharacterId) ? 'checked' : ''}
                           onchange="toggleProfileSelection('\${profile.CharacterId}', this)">
                    <div class="profile-header">
                        <div class="profile-info">
                            \${characterNameHtml}
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
                        \${actionButtons}
                    </div>
                `;
                grid.appendChild(card);
            });
        }
        
        // New modal-based moderation functions
        function initRemoveProfile(characterId, characterName) {
            const bodyContent = `
                <div class="modal-profile-info">
                    <div class="modal-profile-name">\${characterName}</div>
                    <div class="modal-profile-id">\${characterId}</div>
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Remove their profile from the gallery</li>
                    <li>Delete their profile image (if any)</li>
                    <li>They can still upload new profiles unless banned separately</li>
                </ul>
                <textarea id="removeReason" class="modal-input modal-textarea" placeholder="Enter reason for removal (required for moderation logs)" required></textarea>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeRemoveProfile('\${characterId}', '\${characterName.replace(/'/g, "\\'")}')">Remove Profile</button>
            `;
            
            showModal('🗑️ Remove Profile', 'This action cannot be undone', bodyContent, actions);
        }
        
        async function executeRemoveProfile(characterId, characterName) {
            const reason = document.getElementById('removeReason').value.trim();
            
            if (!reason) {
                showToast('Removal reason is required', 'error');
                return;
            }
            
            closeModal();
            
            // Show processing state
            const profileCards = document.querySelectorAll('.profile-card');
            let profileCard = null;
            profileCards.forEach(card => {
                const checkbox = card.querySelector('.bulk-selector');
                if (checkbox && checkbox.dataset.characterId === characterId) {
                    profileCard = card;
                    card.classList.add('processing');
                }
            });
            
            try {
                const response = await fetch(`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ reason, ban: false, adminId: adminName })
                });
                
                if (response.ok) {
                    showToast(\`"\${characterName}" has been removed from gallery\`, 'success');
                    
                    // Remove from current view without full reload
                    if (profileCard) {
                        profileCard.remove();
                    }
                    
                    // Update the filtered profiles array
                    filteredProfiles = filteredProfiles.filter(p => p.CharacterId !== characterId);
                    allProfiles = allProfiles.filter(p => p.CharacterId !== characterId);
                    selectedProfiles.delete(characterId);
                    
                    // Update pagination and bulk bar
                    updatePaginationControls();
                    updateBulkActionsBar();
                    
                    // Refresh stats
                    refreshStats();
                } else {
                    throw new Error('Server error');
                }
            } catch (error) {
                showToast(\`Error removing profile: \${error.message}\`, 'error');
                if (profileCard) {
                    profileCard.classList.remove('processing');
                }
            }
        }
        
        function initBanProfile(characterId, characterName) {
            const bodyContent = `
                <div class="modal-profile-info">
                    <div class="modal-profile-name">\${characterName}</div>
                    <div class="modal-profile-id">\${characterId}</div>
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Permanently ban them from uploading any profiles</li>
                    <li>Their current profile will remain in the gallery unless removed separately</li>
                    <li>Ban can be lifted later if needed</li>
                </ul>
                <textarea id="banReason" class="modal-input modal-textarea" placeholder="Enter reason for ban (required for moderation logs)" required></textarea>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-warning" onclick="executeBanProfile('\${characterId}', '\${characterName.replace(/'/g, "\\'")}')">Ban Profile</button>
            `;
            
            showModal('🚫 Ban Profile', 'This will prevent future uploads', bodyContent, actions);
        }
        
        async function executeBanProfile(characterId, characterName) {
            const reason = document.getElementById('banReason').value.trim();
            
            if (!reason) {
                showToast('Ban reason is required', 'error');
                return;
            }
            
            closeModal();
            
            const profileCards = document.querySelectorAll('.profile-card');
            let profileCard = null;
            profileCards.forEach(card => {
                const checkbox = card.querySelector('.bulk-selector');
                if (checkbox && checkbox.dataset.characterId === characterId) {
                    profileCard = card;
                    card.classList.add('processing');
                }
            });
            
            try {
                const response = await fetch(`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/ban`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ reason, adminId: adminName })
                });
                
                if (response.ok) {
                    showToast(\`"\${characterName}" has been banned\`, 'success');
                    refreshStats();
                } else {
                    throw new Error('Server error');
                }
            } catch (error) {
                showToast(\`Error banning profile: \${error.message}\`, 'error');
            } finally {
                if (profileCard) {
                    profileCard.classList.remove('processing');
                }
            }
        }
        
        function initMarkNSFW(characterId, characterName) {
            const bodyContent = `
                <div class="modal-profile-info">
                    <div class="modal-profile-name">\${characterName}</div>
                    <div class="modal-profile-id">\${characterId}</div>
                </div>
                <p><strong>This will:</strong></p>
                <ul style="margin: 10px 0 10px 20px; color: #ddd;">
                    <li>Mark the profile as NSFW content</li>
                    <li>Hide it from users with safe browsing enabled</li>
                    <li>Add 🔞 NSFW badge to the profile</li>
                    <li>Cannot be undone (use Remove if needed)</li>
                </ul>
                <p style="color: #ff9800; font-weight: bold;">⚠️ Confirm this profile contains adult content</p>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-nsfw" onclick="executeMarkNSFW('\${characterId}', '\${characterName.replace(/'/g, "\\'")}')">Mark as NSFW</button>
            `;
            
            showModal('🔞 Mark as NSFW', 'Adult content classification', bodyContent, actions);
        }
        
        async function executeMarkNSFW(characterId, characterName) {
            closeModal();
            
            const profileCards = document.querySelectorAll('.profile-card');
            let profileCard = null;
            profileCards.forEach(card => {
                const checkbox = card.querySelector('.bulk-selector');
                if (checkbox && checkbox.dataset.characterId === characterId) {
                    profileCard = card;
                    card.classList.add('processing');
                }
            });
            
            try {
                const response = await fetch(`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/nsfw`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ isNSFW: true })
                });
                
                if (response.ok) {
                    showToast(\`"\${characterName}" has been marked as NSFW\`, 'success');
                    
                    // Update the profile in current view
                    const profileIndex = allProfiles.findIndex(p => p.CharacterId === characterId);
                    if (profileIndex !== -1) {
                        allProfiles[profileIndex].IsNSFW = true;
                        applyFilters(); // Re-render with updated data
                    }
                } else {
                    throw new Error('Server error');
                }
            } catch (error) {
                showToast(\`Error updating NSFW status: \${error.message}\`, 'error');
            } finally {
                if (profileCard) {
                    profileCard.classList.remove('processing');
                }
            }
        }
        
        async function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            
            await refreshStats();
            
            switch(tabName) {
                case 'profiles':
                    loadProfiles();
                    break;
                case 'activity':
                    loadActivityFeed();
                    break;
                case 'flagged':
                    loadFlaggedProfiles();
                    break;
                case 'messages':
                    loadMessages();
                    break;
                case 'storage':
                    loadStorageData();
                    break;
                case 'announcements':
                    loadAnnouncements();
                    break;
                case 'reports':
                    loadReports();
                    break;
                case 'archived':
                    loadArchivedReports();
                    break;
                case 'banned':
                    loadBannedProfiles();
                    break;
                case 'moderation':
                    loadModerationLog();
                    break;
            }
        }
        
        async function loadDashboard() {
            adminKey = document.getElementById('adminKey').value;
            adminName = document.getElementById('adminName').value;
            
            if (!adminKey) {
                showToast('Please enter your admin key', 'error');
                return;
            }
            
            if (!adminName) {
                showToast('Please enter your admin name', 'error');
                return;
            }
            
            try {
                console.log('🔐 Testing credentials before saving...');
                await refreshStats();
                
                console.log('✅ Authentication successful, saving credentials...');
                localStorage.setItem('cs_admin_key', adminKey);
                localStorage.setItem('cs_admin_name', adminName);
                console.log('💾 Credentials saved to localStorage');
                
                document.getElementById('dashboardContent').style.display = 'block';
                document.querySelector('.auth-section').style.display = 'none';
                loadProfiles();
                
                showToast('Dashboard loaded successfully', 'success');
                
            } catch (error) {
                console.error('❌ Authentication failed:', error);
                showToast(\`Authentication failed: \${error.message}\`, 'error');
            }
        }
        
        async function refreshStats() {
            if (!adminKey) return;
            
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) {
                refreshBtn.textContent = '🔄 Refreshing...';
                refreshBtn.disabled = true;
            }
            
            try {
                const response = await fetch(`\${serverUrl}/admin/dashboard?adminKey=\${adminKey}`);
                if (!response.ok) {
                    throw new Error('Failed to load stats');
                }
                
                const stats = await response.json();
                
                document.getElementById('totalProfiles').textContent = stats.totalProfiles;
                document.getElementById('pendingReports').textContent = stats.pendingReports;
                document.getElementById('totalBanned').textContent = stats.totalBanned;
                document.getElementById('activeAnnouncements').textContent = stats.activeAnnouncements;
                
            } catch (error) {
                console.error('Error refreshing:', error);
                throw error; // Re-throw for auth check
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
                const response = await fetch(`\${serverUrl}/gallery?admin=true&key=\${adminKey}`);
                const profiles = await response.json();
                
                loading.style.display = 'none';
                allProfiles = profiles;
                
                availableServers.clear();
                profiles.forEach(profile => {
                    if (profile.Server) {
                        availableServers.add(profile.Server);
                    }
                });
                populateServerDropdown();
                
                applyFilters();
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading profiles: \${error.message}</div>`;
            }
        }
        
        // Activity Feed Functions
        async function loadActivityFeed() {
            const loading = document.getElementById('activityLoading');
            const container = document.getElementById('activityContainer');
            const typeFilter = document.getElementById('activityTypeFilter').value;
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                let url = `\${serverUrl}/admin/activity?adminKey=\${adminKey}`;
                if (typeFilter) {
                    url += `&type=\${typeFilter}`;
                }
                
                const response = await fetch(url);
                const activities = await response.json();
                
                loading.style.display = 'none';
                
                if (activities.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px;">📭 No activity to show</div>';
                    return;
                }
                
                activities.forEach(activity => {
                    const item = document.createElement('div');
                    item.className = `activity-item \${activity.type}`;
                    
                    const timeAgo = getTimeAgo(activity.timestamp);
                    let metadataText = '';
                    
                    if (activity.metadata) {
                        const meta = activity.metadata;
                        switch(activity.type) {
                            case 'upload':
                                metadataText = `Server: \${meta.server || 'Unknown'}\${meta.hasImage ? ' • Has Image' : ''}`;
                                break;
                            case 'like':
                                metadataText = `Total Likes: \${meta.newCount || 0}`;
                                break;
                            case 'report':
                                metadataText = `Reason: \${meta.reason || 'Unknown'} • Reporter: \${meta.reporterCharacter || 'Anonymous'}`;
                                break;
                            case 'moderation':
                                metadataText = `Action: \${meta.action || 'Unknown'} • Admin: \${meta.adminId || 'Unknown'}`;
                                break;
                            case 'flag':
                                metadataText = `Keywords: \${meta.keywords ? meta.keywords.join(', ') : 'Unknown'}`;
                                break;
                        }
                    }
                    
                    item.innerHTML = `
                        <div class="activity-content">
                            <div class="activity-message">\${activity.message}</div>
                            \${metadataText ? `<div class="activity-metadata">\${metadataText}</div>` : ''}
                        </div>
                        <div class="activity-time">\${timeAgo}</div>
                    `;
                    
                    container.appendChild(item);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading activity: \${error.message}</div>`;
            }
        }
        
        function toggleAutoRefresh() {
            const checkbox = document.getElementById('autoRefreshActivity');
            const refreshBtn = document.getElementById('refreshActivityBtn');
            
            if (checkbox.checked) {
                activityRefreshInterval = setInterval(() => {
                    if (document.querySelector('.tab.active').onclick.toString().includes('activity')) {
                        loadActivityFeed();
                    }
                }, 30000);
                refreshBtn.textContent = '🔄 Auto-refreshing (30s)';
            } else {
                if (activityRefreshInterval) {
                    clearInterval(activityRefreshInterval);
                    activityRefreshInterval = null;
                }
                refreshBtn.textContent = '🔄 Refresh';
            }
        }
        
        function getTimeAgo(timestamp) {
            const now = new Date();
            const time = new Date(timestamp);
            const diffMs = now - time;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `\${diffMins}m ago`;
            if (diffHours < 24) return `\${diffHours}h ago`;
            if (diffDays < 7) return `\${diffDays}d ago`;
            
            return time.toLocaleDateString();
        }
        
        // Auto-Flagging Functions
        async function loadFlaggedProfiles() {
            const loading = document.getElementById('flaggedLoading');
            const container = document.getElementById('flaggedContainer');
            const statusFilter = document.getElementById('flagStatusFilter').value;
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                let url = `\${serverUrl}/admin/flagged?adminKey=\${adminKey}`;
                if (statusFilter) {
                    url += `&status=\${statusFilter}`;
                }
                
                const response = await fetch(url);
                const flaggedProfiles = await response.json();
                
                loading.style.display = 'none';
                
                if (flaggedProfiles.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No flagged content!</div>';
                    return;
                }
                
                flaggedProfiles.forEach(flag => {
                    const card = document.createElement('div');
                    card.className = 'flagged-card';
                    
                    const timeAgo = getTimeAgo(flag.flaggedAt);
                    const keywordsHtml = flag.flaggedKeywords.map(kw => 
                        `<span class="flagged-keywords">\${kw}</span>`
                    ).join('');
                    
                    const statusBadge = flag.status === 'pending' ? 
                        '<span style="background: rgba(255, 152, 0, 0.2); color: #ff9800; padding: 4px 8px; border-radius: 4px;">⏳ PENDING</span>' :
                        flag.status === 'approved' ?
                        '<span style="background: rgba(76, 175, 80, 0.2); color: #4CAF50; padding: 4px 8px; border-radius: 4px;">✅ APPROVED</span>' :
                        '<span style="background: rgba(244, 67, 54, 0.2); color: #f44336; padding: 4px 8px; border-radius: 4px;">❌ REMOVED</span>';
                    
                    const actionButtons = flag.status === 'pending' ? `
                        <div style="margin-top: 10px;">
                            <button class="btn btn-primary" onclick="updateFlagStatus('\${flag.id}', 'approved')">Approve</button>
                            <button class="btn btn-danger" onclick="updateFlagStatus('\${flag.id}', 'removed')">Remove</button>
                            <button class="btn btn-warning" onclick="initRemoveProfile('\${flag.characterId}', '\${flag.characterName.replace(/'/g, "\\'")}')">Remove Profile</button>
                        </div>
                    ` : '';
                    
                    card.innerHTML = `
                        <div class="flagged-header">
                            <strong>\${flag.characterName}</strong>
                            \${statusBadge}
                        </div>
                        <div style="margin: 10px 0;">
                            <strong>Flagged Keywords:</strong><br>
                            \${keywordsHtml}
                        </div>
                        <div class="flagged-content">
                            \${flag.content}
                        </div>
                        <div style="margin-top: 10px; font-size: 0.9em; color: #aaa;">
                            <strong>Flagged:</strong> \${timeAgo}
                            \${flag.reviewedBy ? ` • <strong>Reviewed by:</strong> \${flag.reviewedBy}` : ''}
                        </div>
                        \${actionButtons}
                    `;
                    
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading flagged content: \${error.message}</div>`;
            }
        }
        
        async function updateFlagStatus(flagId, status) {
            try {
                const response = await fetch(`\${serverUrl}/admin/flagged/\${flagId}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ status })
                });
                
                if (response.ok) {
                    showToast(\`Flag \${status}\`, 'success');
                    loadFlaggedProfiles();
                } else {
                    showToast('Error updating flag status', 'error');
                }
            } catch (error) {
                showToast(\`Error: \${error.message}\`, 'error');
            }
        }
        
        function showKeywordManager() {
            promptAction(
                '🔍 Add Keyword',
                'Add new keyword to auto-flag list:',
                'Enter keyword...',
                'addFlagKeyword'
            );
        }
        
        async function addFlagKeyword(keyword) {
            try {
                const response = await fetch(`\${serverUrl}/admin/flagged/keywords`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ keyword })
                });
                
                if (response.ok) {
                    showToast(\`Added keyword: "\${keyword}"\`, 'success');
                } else {
                    showToast('Error adding keyword', 'error');
                }
            } catch (error) {
                showToast(\`Error: \${error.message}\`, 'error');
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
        
        async function unbanProfile(characterId, characterName) {
            promptAction(
                '🔓 Unban Profile',
                `Why are you unbanning \${characterName || characterId}?`,
                'Enter reason...',
                'executeUnbanProfile',
                false
            );
            
            // Store the character info for the callback
            window.currentUnbanCharacterId = characterId;
            window.currentUnbanCharacterName = characterName;
        }
        
        async function executeUnbanProfile(reason) {
            const characterId = window.currentUnbanCharacterId;
            const characterName = window.currentUnbanCharacterName;
            
            try {
                const response = await fetch(`\${serverUrl}/admin/profiles/\${encodeURIComponent(characterId)}/unban`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey
                    },
                    body: JSON.stringify({ reason })
                });
                
                if (response.ok) {
                    showToast(\`\${characterName || characterId} has been unbanned\`, 'success');
                    await loadBannedProfiles();
                    await refreshStats();
                } else {
                    showToast('Error unbanning profile', 'error');
                }
            } catch (error) {
                showToast(\`Error: \${error.message}\`, 'error');
            }
        }
        
        async function loadBannedProfiles() {
            const loading = document.getElementById('bannedLoading');
            const container = document.getElementById('bannedContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(`\${serverUrl}/admin/moderation/banned?adminKey=\${adminKey}`);
                const bannedIds = await response.json();
                
                loading.style.display = 'none';
                
                if (bannedIds.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No banned profiles!</div>';
                    return;
                }
                
                const galleryResponse = await fetch(`\${serverUrl}/gallery?admin=true&key=\${adminKey}`);
                const allProfiles = galleryResponse.ok ? await galleryResponse.json() : [];
                
                bannedIds.forEach(bannedId => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.style.borderLeft = '4px solid #f44336';
                    
                    const profile = allProfiles.find(p => p.CharacterId === bannedId);
                    
                    if (profile) {
                        const imageHtml = profile.ProfileImageUrl 
                            ? `<img src="\${profile.ProfileImageUrl}" 
                                    alt="\${profile.CharacterName}" 
                                    class="profile-image" 
                                    onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                               <div class="profile-image-placeholder" style="display: none;">🖼️</div>`
                            : `<div class="profile-image-placeholder">🖼️</div>`;
                        
                        card.innerHTML = `
                            <div class="profile-header">
                                <div class="profile-info">
                                    <div class="profile-name" style="color: #f44336;">🚫 \${profile.CharacterName}</div>
                                    <div class="profile-id">\${profile.CharacterId}</div>
                                    <div style="margin-top: 8px; display: flex; align-items: center; gap: 10px;">
                                        <span style="color: #ccc; font-size: 0.9em;">\${profile.Server}</span>
                                        <span style="color: #f44336;">BANNED</span>
                                    </div>
                                </div>
                                \${imageHtml}
                            </div>
                            <div class="profile-content">
                                \${profile.Bio || profile.GalleryStatus || 'No bio'}
                            </div>
                            <div class="profile-actions">
                                <button class="btn btn-primary" onclick="unbanProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                                    Unban
                                </button>
                            </div>
                        `;
                    } else {
                        card.innerHTML = `
                            <div class="profile-header">
                                <div class="profile-info">
                                    <div class="profile-name" style="color: #f44336;">🚫 \${bannedId}</div>
                                    <div class="profile-id">Profile Removed</div>
                                    <div style="margin-top: 8px;">
                                        <span style="color: #f44336;">BANNED</span>
                                    </div>
                                </div>
                                <div class="profile-image-placeholder">❌</div>
                            </div>
                            <div class="profile-content">
                                Profile was removed but ban still active
                            </div>
                            <div class="profile-actions">
                                <button class="btn btn-primary" onclick="unbanProfile('\${bannedId}', '\${bannedId}')">
                                    Unban
                                </button>
                            </div>
                        `;
                    }
                    
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading banned profiles: \${error.message}</div>`;
            }
        }
        
        async function loadReports() {
            const loading = document.getElementById('reportsLoading');
            const container = document.getElementById('reportsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(`\${serverUrl}/admin/reports?status=pending&adminKey=\${adminKey}`);
                const reports = await response.json();
                
                loading.style.display = 'none';
                
                if (reports.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #4CAF50; padding: 20px;">🎉 No pending reports!</div>';
                    return;
                }
                
                await renderReports(reports, container);
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading reports: \${error.message}</div>`;
            }
        }
        
        let allArchivedReports = [];
        
        async function loadArchivedReports() {
            const loading = document.getElementById('archivedLoading');
            const container = document.getElementById('archivedContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(`\${serverUrl}/admin/reports?adminKey=\${adminKey}`);
                const allReports = await response.json();
                
                allArchivedReports = allReports.filter(report => 
                    report.status === 'resolved' || report.status === 'dismissed'
                );
                
                loading.style.display = 'none';
                
                if (allArchivedReports.length === 0) {
                    container.innerHTML = '<div style="text-align: center; color: #ccc; padding: 20px;">📁 No archived reports</div>';
                    return;
                }
                
                await renderReports(allArchivedReports, container, true);
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading archived reports: \${error.message}</div>`;
            }
        }
        
        function filterArchivedReports() {
            const searchTerm = document.getElementById('reportSearch').value.toLowerCase();
            const container = document.getElementById('archivedContainer');
            
            if (!searchTerm) {
                renderReports(allArchivedReports, container, true);
                return;
            }
            
            const filteredReports = allArchivedReports.filter(report =>
                report.reportedCharacterName.toLowerCase().includes(searchTerm) ||
                report.reporterCharacter.toLowerCase().includes(searchTerm)
            );
            
            renderReports(filteredReports, container, true);
        }
        
        async function renderReports(reports, container, isArchived = false) {
            container.innerHTML = '';
            
            if (isArchived) {
                const groupedReports = {};
                reports.forEach(report => {
                    if (!groupedReports[report.reportedCharacterName]) {
                        groupedReports[report.reportedCharacterName] = [];
                    }
                    groupedReports[report.reportedCharacterName].push(report);
                });
                
                const summary = document.createElement('div');
                summary.style.cssText = 'background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 8px; margin-bottom: 15px; color: #ccc;';
                const uniqueReported = Object.keys(groupedReports).length;
                const totalReports = reports.length;
                const repeatOffenders = Object.entries(groupedReports).filter(([name, reports]) => reports.length > 1);
                
                summary.innerHTML = `
                    📊 \${totalReports} archived reports for \${uniqueReported} characters
                    \${repeatOffenders.length > 0 ? `<br>⚠️ \${repeatOffenders.length} characters with multiple reports` : ''}
                `;
                container.appendChild(summary);
                
                if (repeatOffenders.length > 0) {
                    const repeatDiv = document.createElement('div');
                    repeatDiv.style.cssText = 'background: rgba(255, 152, 0, 0.1); border: 1px solid #ff9800; padding: 10px; border-radius: 8px; margin-bottom: 15px;';
                    repeatDiv.innerHTML = `
                        <strong>🔄 Multiple Reports:</strong><br>
                        \${repeatOffenders.map(([name, reps]) => `\${name} (\${reps.length} reports)`).join(', ')}
                    `;
                    container.appendChild(repeatDiv);
                }
            }
            
            for (const report of reports) {
                const card = document.createElement('div');
                
                const reasonClass = getReasonClass(report.reason);
                card.className = `report-card \${reasonClass}`;
                
                let profileHtml = '';
                try {
                    const response = await fetch(`\${serverUrl}/gallery?admin=true&key=\${adminKey}`);
                    const profiles = await response.json();
                    
                    const profile = profiles.find(p => 
                        p.CharacterName === report.reportedCharacterName || 
                        p.CharacterId === report.reportedCharacterId
                    );
                    
                    if (profile) {
                        const imageHtml = profile.ProfileImageUrl 
                            ? `<img src="\${profile.ProfileImageUrl}" 
                                    alt="\${profile.CharacterName}" 
                                    class="reported-profile-image" 
                                    onclick="openImageModal('\${profile.ProfileImageUrl}', '\${profile.CharacterName}')"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                               <div class="reported-profile-placeholder" style="display: none;">🖼️</div>`
                            : `<div class="reported-profile-placeholder">🖼️</div>`;
                        
                        const actionButtonsHtml = !isArchived ? `
                            <div class="reported-profile-actions">
                                <button class="btn btn-danger" onclick="initRemoveProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                                    Remove
                                </button>
                                <button class="btn btn-warning" onclick="initBanProfile('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">
                                    Ban
                                </button>
                                \${profile.IsNSFW ? '' : `<button class="btn btn-nsfw" onclick="initMarkNSFW('\${profile.CharacterId}', '\${profile.CharacterName.replace(/'/g, "\\'")}')">Mark NSFW</button>`}
                            </div>
                        ` : '';
                        
                        let statusContent = '';
                        if (profile.GalleryStatus && profile.GalleryStatus.trim()) {
                            statusContent = `<div class="gallery-status">\${profile.GalleryStatus}</div>`;
                        } else if (profile.Bio && profile.Bio.trim()) {
                            statusContent = `<div style="color: #ddd; font-size: 0.9em; margin: 4px 0; max-height: 60px; overflow: hidden;">\${profile.Bio}</div>`;
                        } else {
                            statusContent = `<div style="color: #999; font-style: italic; margin: 4px 0;">No bio</div>`;
                        }

                        profileHtml = `
                            <div class="reported-profile">
                                \${imageHtml}
                                <div class="reported-profile-name">\${profile.CharacterName}</div>
                                <div class="reported-profile-server">\${profile.Server}</div>
                                \${statusContent}
                                \${actionButtonsHtml}
                            </div>
                        `;
                    } else {
                        profileHtml = `
                            <div class="reported-profile">
                                <div class="reported-profile-placeholder">❌</div>
                                <div class="reported-profile-name">Profile Missing</div>
                                <div class="reported-profile-server">Removed/Private</div>
                            </div>
                        `;
                    }
                } catch (error) {
                    profileHtml = `
                        <div class="reported-profile">
                            <div class="reported-profile-placeholder">⚠️</div>
                            <div class="reported-profile-name">Error Loading</div>
                            <div class="reported-profile-server">-</div>
                        </div>
                    `;
                }
                
                const actionButtons = report.status === 'pending' ? `
                    <div style="margin-top: 10px;">
                        <button class="btn btn-primary" onclick="initUpdateReport('\${report.id}', 'resolved')">Mark Resolved</button>
                        <button class="btn btn-warning" onclick="initUpdateReport('\${report.id}', 'dismissed')">Dismiss</button>
                    </div>
                ` : `
                    <div style="margin-top: 10px;">
                        <span style="color: #4CAF50; font-size: 0.9em;">✅ \${report.status.toUpperCase()}</span>
                        \${report.reviewedAt ? ` on \${new Date(report.reviewedAt).toLocaleDateString()}` : ''}
                        \${report.reviewedBy ? ` by \${report.reviewedBy}` : ''}
                        \${report.adminNotes ? `<br><strong>Admin Notes:</strong> \${report.adminNotes}` : ''}
                    </div>
                `;
                
                card.innerHTML = `
                    <div class="report-info">
                        <div class="report-header">
                            <strong>\${report.reportedCharacterName}</strong>
                            <span class="btn btn-\${report.status === 'pending' ? 'warning' : (report.status === 'resolved' ? 'primary' : 'secondary')}">\${report.status}</span>
                        </div>
                        <div class="reason-badge \${reasonClass}">\${report.reason}</div>
                        <p><strong>Details:</strong> \${report.details || 'None'}</p>
                        <p><strong>Reported by:</strong> \${report.reporterCharacter}</p>
                        <p><strong>Date:</strong> \${new Date(report.createdAt).toLocaleDateString()}</p>
                        \${actionButtons}
                    </div>
                    \${profileHtml}
                `;
                container.appendChild(card);
            }
        }
        
        function initUpdateReport(reportId, status) {
            const statusText = status === 'resolved' ? 'Mark as Resolved' : 'Dismiss Report';
            const statusColor = status === 'resolved' ? 'success' : 'warning';
            
            const bodyContent = `
                <p>Update report status to: <strong>\${status.toUpperCase()}</strong></p>
                <textarea id="adminNotes" class="modal-input modal-textarea" placeholder="Add admin notes (optional)"></textarea>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-\${statusColor}" onclick="executeUpdateReport('\${reportId}', '\${status}')">\${statusText}</button>
            `;
            
            showModal('📋 Update Report', 'Add optional notes', bodyContent, actions);
        }
        
        async function executeUpdateReport(reportId, status) {
            const adminNotes = document.getElementById('adminNotes').value.trim();
            
            closeModal();
            
            try {
                const response = await fetch(`\${serverUrl}/admin/reports/\${reportId}`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ status, adminNotes })
                });
                
                if (response.ok) {
                    showToast('✅ Report updated', 'success');
                    await loadReports();
                    await loadArchivedReports();
                    await refreshStats();
                } else {
                    showToast('❌ Error updating report', 'error');
                }
            } catch (error) {
                showToast(\`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        // Helper function to get CSS class based on report reason
        function getReasonClass(reason) {
            const reasonLower = reason.toLowerCase();
            if (reasonLower.includes('spam')) return 'reason-spam';
            if (reasonLower.includes('inappropriate') || reasonLower.includes('content')) return 'reason-inappropriate';
            if (reasonLower.includes('malicious') || reasonLower.includes('link')) return 'reason-malicious';
            if (reasonLower.includes('harassment') || reasonLower.includes('abuse')) return 'reason-harassment';
            return 'reason-other';
        }
        
        async function createAnnouncement() {
            const title = document.getElementById('announcementTitle').value;
            const message = document.getElementById('announcementMessage').value;
            const type = document.getElementById('announcementType').value;
            
            if (!title || !message) {
                showToast('Please fill in title and message', 'error');
                return;
            }
            
            try {
                const response = await fetch(`\${serverUrl}/admin/announcements`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    },
                    body: JSON.stringify({ title, message, type })
                });
                
                if (response.ok) {
                    showToast('✅ Announcement created', 'success');
                    document.getElementById('announcementTitle').value = '';
                    document.getElementById('announcementMessage').value = '';
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    showToast('❌ Error creating announcement', 'error');
                }
            } catch (error) {
                showToast(\`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        async function loadAnnouncements() {
            const loading = document.getElementById('announcementsLoading');
            const container = document.getElementById('announcementsContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(`\${serverUrl}/admin/announcements?adminKey=\${adminKey}`);
                const announcements = await response.json();
                
                loading.style.display = 'none';
                
                announcements.forEach(announcement => {
                    const card = document.createElement('div');
                    card.className = 'announcement-card';
                    card.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <strong>\${announcement.title}</strong>
                            <span class="btn btn-\${announcement.active ? 'primary' : 'warning'}">\${announcement.active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <p>\${announcement.message}</p>
                        <p><strong>Type:</strong> \${announcement.type}</p>
                        <p><strong>Created:</strong> \${new Date(announcement.createdAt).toLocaleDateString()}</p>
                        \${announcement.active ? `
                            <button class="btn btn-warning" onclick="deactivateAnnouncement('\${announcement.id}')">Deactivate</button>
                        ` : ''}
                        <button class="btn btn-danger" onclick="initDeleteAnnouncement('\${announcement.id}', '\${announcement.title.replace(/'/g, "\\'")}')">Delete</button>
                    `;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading announcements: \${error.message}</div>`;
            }
        }
        
        async function deactivateAnnouncement(id) {
            try {
                const response = await fetch(`\${serverUrl}/admin/announcements/\${id}/deactivate`, {
                    method: 'PATCH',
                    headers: { 
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    showToast('Announcement deactivated', 'success');
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    showToast('❌ Error deactivating announcement', 'error');
                }
            } catch (error) {
                showToast(\`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        function initDeleteAnnouncement(id, title) {
            const bodyContent = `
                <p>Are you sure you want to delete this announcement?</p>
                <div style="background: rgba(255, 255, 255, 0.1); padding: 10px; border-radius: 8px; margin: 10px 0;">
                    <strong>\${title}</strong>
                </div>
                <p style="color: #f44336;">This action cannot be undone.</p>
            `;
            
            const actions = `
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="executeDeleteAnnouncement('\${id}')">Delete</button>
            `;
            
            showModal('🗑️ Delete Announcement', 'Confirm deletion', bodyContent, actions);
        }
        
        async function executeDeleteAnnouncement(id) {
            closeModal();
            
            try {
                const response = await fetch(`\${serverUrl}/admin/announcements/\${id}`, {
                    method: 'DELETE',
                    headers: { 
                        'X-Admin-Key': adminKey,
                        'X-Admin-Id': adminName
                    }
                });
                
                if (response.ok) {
                    showToast('Announcement deleted', 'success');
                    loadAnnouncements();
                    await refreshStats();
                } else {
                    showToast('❌ Error deleting announcement', 'error');
                }
            } catch (error) {
                showToast(\`❌ Error: \${error.message}\`, 'error');
            }
        }
        
        async function loadModerationLog() {
            const loading = document.getElementById('moderationLoading');
            const container = document.getElementById('moderationContainer');
            
            loading.style.display = 'block';
            container.innerHTML = '';
            
            try {
                const response = await fetch(`\${serverUrl}/admin/moderation/actions?adminKey=\${adminKey}`);
                const actions = await response.json();
                
                loading.style.display = 'none';
                
                actions.forEach(action => {
                    const card = document.createElement('div');
                    card.className = 'profile-card';
                    card.innerHTML = `
                        <div><strong>\${action.action.toUpperCase()}</strong> - \${action.characterName}</div>
                        <p><strong>Reason:</strong> \${action.reason}</p>
                        <p><strong>Admin:</strong> \${action.adminId}</p>
                        <p><strong>Date:</strong> \${new Date(action.timestamp).toLocaleString()}</p>
                    `;
                    container.appendChild(card);
                });
                
            } catch (error) {
                loading.innerHTML = `<div class="error">Error loading moderation log: \${error.message}</div>`;
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
        const newFileName = `\${sanitizedCSName}_\${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `\${newFileName}.json`);

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

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/\${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', `NEW PROFILE: \${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ Saved profile: \${newFileName}.json (likes: \${profile.LikeCount})`);
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
        const newFileName = `\${sanitizedCSName}_\${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `\${newFileName}.json`);

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
            
            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/\${safeFileName}`;
        }

        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        galleryCache = null;

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', `UPDATED PROFILE: \${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ PUT updated profile: \${newFileName}.json (likes: \${profile.LikeCount})`);
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
        let filePath = path.join(profilesDir, `\${requestedName}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                const sanitizedProfile = sanitizeProfileResponse(profile);
                return res.json(sanitizedProfile);
            } catch (err) {
                console.error(`Error reading profile \${requestedName}:`, err.message);
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
        const expectedSuffix = `_\${requestedName}.json`;

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
                        console.error(`Error processing \${file}:`, err.message);
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
        console.error(`Error in view endpoint: \${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// Gallery endpoint
app.get("/gallery", async (req, res) => {
    try {
        const isPlugin = req.headers['x-plugin-auth'] === 'cs-plus-gallery-client';
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;
        const showNSFW = req.query.nsfw === 'true'; // Client can request NSFW content
        
        const now = Date.now();
        if (galleryCache && (now - galleryCacheTime) < CACHE_DURATION) {
            let profiles = galleryCache;
            
            // Apply NSFW filter if requested
            if (!showNSFW && !isAdmin) {
                profiles = profiles.filter(profile => !profile.IsNSFW);
            }
            
            if (isPlugin || isAdmin) {
                return res.json(profiles);
            } else {
                return res.json(sanitizeGalleryData(profiles));
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
                            ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                            IsNSFW: profileData.IsNSFW || false // Include NSFW flag
                        };
                    }
                    return null;
                } catch (err) {
                    console.error(`[Error] Failed to process profile \${file}:`, err.message);
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
        
        // Apply NSFW filter
        let filteredProfiles = showcaseProfiles;
        if (!showNSFW && !isAdmin) {
            filteredProfiles = showcaseProfiles.filter(profile => !profile.IsNSFW);
        }
        
        if (isPlugin || isAdmin) {
            res.json(filteredProfiles);
        } else {
            res.json(sanitizeGalleryData(filteredProfiles));
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
        
        // Log activity for new likes only
        if (newCount > (likesDB.getLikeCount(characterId) - 1)) {
            try {
                const filePath = path.join(profilesDir, `\${characterId}.json`);
                if (fs.existsSync(filePath)) {
                    const profile = await readProfileAsync(filePath);
                    activityDB.logActivity('like', `LIKED: \${profile.CharacterName || characterId}`, {
                        characterId,
                        characterName: profile.CharacterName || characterId,
                        likerId,
                        newCount
                    });
                }
            } catch (err) {
                // Silent fail for activity logging
            }
        }
        
        const filePath = path.join(profilesDir, `\${characterId}.json`);
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
        
        const filePath = path.join(profilesDir, `\${characterId}.json`);
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
        
        const followsFile = path.join(profilesDir, `\${character}_follows.json`);
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
        
        // Log activity
        activityDB.logActivity('report', `REPORTED: \${reportedCharacterName || reportedCharacterId}`, {
            reportId: report.id,
            reportedCharacterId,
            reportedCharacterName: reportedCharacterName || reportedCharacterId,
            reporterCharacter,
            reason
        });
        
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
        const adminId = req.adminId;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const success = reportsDB.updateReportStatus(id, status, adminNotes, adminId);
        
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
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `\${characterId}.json`);
        
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
                console.log(`🗑️ Deleted associated image: \${associatedImage}`);
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
        
        console.log(`🛡️ Profile \${characterName} removed by \${adminId}\${ban ? ' and banned' : ''}`);
        res.json({ success: true, banned: !!ban });
        
    } catch (error) {
        console.error('Remove profile error:', error);
        res.status(500).json({ error: 'Failed to remove profile' });
    }
});

// Update profile NSFW status (admin only)
app.patch("/admin/profiles/:characterId/nsfw", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { isNSFW } = req.body;
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `\${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Read current profile
        const profile = await readProfileAsync(filePath);
        
        // Update NSFW status
        profile.IsNSFW = isNSFW;
        profile.LastUpdated = new Date().toISOString();
        
        // Save updated profile
        await atomicWriteProfile(filePath, profile);
        
        // Log moderation action
        moderationDB.logAction(
            isNSFW ? 'mark_nsfw' : 'unmark_nsfw', 
            characterId, 
            profile.CharacterName || characterId, 
            `Profile \${isNSFW ? 'marked as' : 'unmarked from'} NSFW`, 
            adminId
        );
        
        // Clear gallery cache to reflect changes
        galleryCache = null;
        
        console.log(`🛡️ Profile \${profile.CharacterName} \${isNSFW ? 'marked as' : 'unmarked from'} NSFW by \${adminId}`);
        res.json({ success: true, isNSFW });
        
    } catch (error) {
        console.error('Update NSFW status error:', error);
        res.status(500).json({ error: 'Failed to update NSFW status' });
    }
});

// Ban profile (admin only)
app.post("/admin/profiles/:characterId/ban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.adminId;
        
        moderationDB.banProfile(characterId);
        moderationDB.logAction('ban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile \${characterId} banned by \${adminId}`);
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
        const adminId = req.adminId;
        
        moderationDB.unbanProfile(characterId);
        moderationDB.logAction('unban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile \${characterId} unbanned by \${adminId}`);
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

// Admin dashboard endpoint
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
            recentActions: moderationDB.getActions().slice(0, 10),
            pendingFlags: autoFlagDB.getFlaggedProfiles('pending').length
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to get dashboard data' });
    }
});

// Activity Feed endpoints
app.get("/admin/activity", requireAdmin, (req, res) => {
    try {
        const { type, limit } = req.query;
        let activities;
        
        if (type) {
            activities = activityDB.getActivitiesByType(type, parseInt(limit) || 50);
        } else {
            activities = activityDB.getActivities(parseInt(limit) || 50);
        }
        
        res.json(activities);
    } catch (error) {
        console.error('Get activity error:', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// Auto-flagging endpoints
app.get("/admin/flagged", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const flaggedProfiles = autoFlagDB.getFlaggedProfiles(status);
        res.json(flaggedProfiles);
    } catch (error) {
        console.error('Get flagged profiles error:', error);
        res.status(500).json({ error: 'Failed to get flagged profiles' });
    }
});

app.patch("/admin/flagged/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const adminId = req.adminId;
        
        const success = autoFlagDB.updateFlagStatus(id, status, adminId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Flag not found' });
        }
    } catch (error) {
        console.error('Update flag status error:', error);
        res.status(500).json({ error: 'Failed to update flag status' });
    }
});

app.post("/admin/flagged/keywords", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ error: 'Valid keyword is required' });
        }
        
        const success = autoFlagDB.addKeyword(keyword);
        
        if (success) {
            res.json({ success: true, message: 'Keyword added' });
        } else {
            res.status(400).json({ error: 'Keyword already exists' });
        }
    } catch (error) {
        console.error('Add keyword error:', error);
        res.status(500).json({ error: 'Failed to add keyword' });
    }
});

app.delete("/admin/flagged/keywords/:keyword", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.params;
        const success = autoFlagDB.removeKeyword(decodeURIComponent(keyword));
        
        if (success) {
            res.json({ success: true, message: 'Keyword removed' });
        } else {
            res.status(404).json({ error: 'Keyword not found' });
        }
    } catch (error) {
        console.error('Remove keyword error:', error);
        res.status(500).json({ error: 'Failed to remove keyword' });
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
    console.log(`✅ Character Select+ RP server running at http://localhost:\${PORT}`);
    console.log(`📁 Profiles directory: \${profilesDir}`);
    console.log(`🖼️ Images directory: \${imagesDir}`);
    console.log(`🛡️ Admin dashboard: http://localhost:\${PORT}/admin`);
    console.log(`💾 Database files: \${likesDbFile}, \${friendsDbFile}, \${announcementsDbFile}, \${reportsDbFile}, \${moderationDbFile}, \${activityDbFile}, \${flaggedDbFile}, \${messagesDbFile}, \${storageDbFile}`);
    console.log(`🚀 Features: Gallery, Likes, Friends, Announcements, Reports, Visual Moderation Dashboard, Activity Feed, Auto-Flagging, Bulk Actions, Communication System, Storage Management`);
    console.log(`🗂️ Using data directory: \${DATA_DIR}`);
    
    if (process.env.ADMIN_SECRET_KEY) {
        console.log(`👑 Admin access enabled - visit /admin to moderate`);
    } else {
        console.log(`⚠️  Admin access disabled - set ADMIN_SECRET_KEY environment variable to enable`);
    }
});
