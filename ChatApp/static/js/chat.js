// Register service worker for PWA support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js') 
            .then(registration => {
                console.log('ServiceWorker registration successful');
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    });
}

function showToast(title, body, position = 'bottom-right') {
    const positionClass = {
        'bottom-right': 'bottom: 20px; right: 20px;',
        'top-center': 'top: 20px; left: 50%; transform: translateX(-50%);'
    }[position] || 'bottom: 20px; right: 20px;';

    const toastHtml = `
        <div class="toast align-items-center text-white bg-primary border-0" role="alert"
             aria-live="assertive" aria-atomic="true"
             style="position: fixed; ${positionClass} z-index: 1080;">
            <div class="d-flex">
                <div class="toast-body">
                    <strong>${title}</strong><br>${body}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto"
                        data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        </div>
    `;
    const toastContainer = document.createElement('div');
    toastContainer.innerHTML = toastHtml;
    document.body.appendChild(toastContainer);

    const toast = new bootstrap.Toast(toastContainer.querySelector('.toast'));
    toast.show();

    toastContainer.querySelector('.toast').addEventListener('hidden.bs.toast', () => {
        toastContainer.remove();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    let unreadCounts = {};
    let socket = null;
    let currentUser = null;
    let currentReceiver = null;
    let replyingTo = null;
    let currentImageData = null;
    let imageGallery = [];
    let currentGroup = null;
    let groupList = [];
    let groupMembers = [];
    let isGroupAdmin = false;
    // Pinned chats state
    const pinnedUsers = new Set();
    const pinnedGroups = new Set();
    let sending = false; // Prevent double-sends
    let pendingAttachments = []; // Support multiple attachments queued
    let directMessagesRequestId = 0; // Dedupe concurrent direct message loads
    let groupMessagesRequestId = 0;  // Dedupe concurrent group message loads
    let lastInteractedMessageId = null; // Track for Alt+R

    // Caches for efficient per-user sorting (memoized last message timestamps)
    const userLastDirectTs = new Map();   // key: userId, value: ms timestamp
    const groupLastActivityTs = new Map(); // key: groupId, value: ms timestamp

    // DOM Elements - Group all element declarations at the top
    const userSelectModalEl = document.getElementById('userSelectModal');
    const userSelectModal = userSelectModalEl ? new bootstrap.Modal(userSelectModalEl) : null;
    const employeeSelect = null;
    let startChatBtn = null;
    const chatContainer = document.getElementById('chatContainer');
    const currentUserSpan = document.getElementById('currentUser');
    const chatWithHeading = document.getElementById('chatWith');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-btn');
    const messagesContainer = document.getElementById('messages');
    const activeUsersList = document.getElementById('active-users-list');
    const uploadButton = document.getElementById('upload-btn');
    const imageUpload = document.getElementById('image-upload');
    const emojiPicker = document.getElementById('emoji-picker');
    const emojiButton = document.getElementById('emoji-btn');
    const replyModal = new bootstrap.Modal(document.getElementById('replyModal'));
    const replyInput = document.getElementById('reply-input');
    const sendReplyButton = document.getElementById('send-reply-btn');
    const toggleDirectChatBtn = document.getElementById('toggleDirectChat');
    const toggleGroupChatBtn = document.getElementById('toggleGroupChat');
    const directChatSearchBox = document.getElementById('directChatSearchBox');
    const groupChatSearchBox = document.getElementById('groupChatSearchBox');
    const groupListUI = document.getElementById('group-list');
    const groupCreateBtnRow = document.getElementById('groupCreateBtnRow');
    const groupSearchInput = document.getElementById('groupSearch');
    const groupMembersModalEl = document.getElementById('groupMembersModal');
    const groupMembersModal = groupMembersModalEl ? new bootstrap.Modal(groupMembersModalEl) : null;
    const groupMembersListContainer = document.getElementById('groupMembersInfoList');
    const groupMembersMeta = document.getElementById('groupMembersMeta');
    const groupMembersModalTitle = document.getElementById('groupMembersModalLabel');
    const virtualScrollContainer = document.querySelector('.virtual-scroll-container');
    const welcomeCard = document.getElementById('welcomeCard');
    const chatHeader = document.querySelector('.chat-area .card-header');
    const chatFooter = document.querySelector('.chat-area .card-footer');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const themeToggleIcon = themeToggleBtn ? themeToggleBtn.querySelector('i') : null;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    
    // Theme utils
    function getStoredTheme() {
        try { return localStorage.getItem('theme'); } catch (_) { return null; }
    }
    function storeTheme(theme) {
        try { localStorage.setItem('theme', theme); } catch (_) {}
    }
    function getPreferredTheme() {
        const stored = getStoredTheme();
        if (stored === 'light' || stored === 'dark') return stored;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function applyTheme(theme) {
        const isDark = theme === 'dark';
        document.body.classList.toggle('dark-theme', isDark);
        // Update PWA toolbar color
        if (themeMeta) themeMeta.setAttribute('content', isDark ? '#0f172a' : '#ffffff');
        // Update button icon and tooltip
        if (themeToggleBtn && themeToggleIcon) {
            if (isDark) {
                themeToggleIcon.classList.remove('fa-moon', 'fa-adjust');
                themeToggleIcon.classList.add('fa-sun');
                themeToggleBtn.title = 'Switch to light theme';
                themeToggleBtn.setAttribute('aria-pressed', 'true');
            } else {
                themeToggleIcon.classList.remove('fa-sun', 'fa-adjust');
                themeToggleIcon.classList.add('fa-moon');
                themeToggleBtn.title = 'Switch to dark theme';
                themeToggleBtn.setAttribute('aria-pressed', 'false');
            }
        }
    }
    function setTheme(theme) {
        applyTheme(theme);
        storeTheme(theme);
    }

    // Timestamp utilities: normalize ISO strings with microseconds to milliseconds
    function toMillis(ts) {
        if (ts == null) return 0;
        if (typeof ts === 'number') return ts;
        let s = String(ts).trim();
        // Convert fractional seconds to 3 digits (milliseconds)
        // Matches ... .123456Z or .12Z or .1Z (with optional trailing Z)
        s = s.replace(/\.(\d{1,6})(Z)?$/, (_, frac, z) => `.${String(frac).padEnd(3, '0').slice(0,3)}${z || ''}`);
        const t = Date.parse(s);
        return isNaN(t) ? 0 : t;
    }

    applyTheme(getPreferredTheme());
    // React to system theme only if user hasn't chosen explicitly
    if (window.matchMedia) {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener && media.addEventListener('change', () => {
            if (!getStoredTheme()) applyTheme(getPreferredTheme());
        });
    }
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const next = document.body.classList.contains('dark-theme') ? 'light' : 'dark';
            setTheme(next);
        });
    }

    const modalImage = document.getElementById('modalImage');
    const prevButton = document.getElementById('prevImage');
    const nextButton = document.getElementById('nextImage');
    const imageModal = new bootstrap.Modal(document.getElementById('imagePreviewModal'));
    let currentImageIndex = 0;

    // Request notification permission
    function requestNotificationPermission() {
        if ('Notification' in window) {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Notification permission granted');
                }
            });
        }
    }

    requestNotificationPermission();
    initEmojiPicker();

    function switchToUser(userId) {
        const userItem = document.querySelector(`.user-item[data-user-id="${userId}"]`);
        if (!userItem) return;
        
        currentReceiver = userId;
        currentGroup = null;
        const userName = userItem.querySelector('.user-name-text')?.textContent.trim();
        
        if (chatWithHeading) chatWithHeading.textContent = userName;
        if (messageInput) messageInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        
        loadMessages(currentUser, currentReceiver);
        updateChatWithStatus(currentReceiver);
        updateActiveUserHighlight();
        hideWelcomeCard();
        
        // Proactively clear unread badge for this user in UI
        unreadCounts[currentReceiver] = 0;
        updateAllUnreadCounts();
        
        // Ensure we're in direct chat mode
        showDirectChat();
    }

    // Welcome card actions
    startChatBtn = document.getElementById('startChatBtn');
    if (startChatBtn) {
        startChatBtn.addEventListener('click', () => {
            // Ensure direct chat mode and focus the search input
            try { showDirectChat(); } catch (_) {}
            const userSearch = document.getElementById('userSearch');
            if (userSearch) {
                userSearch.focus();
                userSearch.select && userSearch.select();
            }
        });
    }

    const viewShortcutsBtn = document.getElementById('viewShortcutsBtn');
    if (viewShortcutsBtn) {
        viewShortcutsBtn.addEventListener('click', () => {
            const modalEl = document.getElementById('shortcutsModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                const modal = new bootstrap.Modal(modalEl);
                modal.show();
            }
        });
    }

    async function fetchJSON(url, options = {}) {
        const res = await fetch(url, { credentials: 'same-origin', ...options });
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            // ignore parse error; data remains null
        }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || res.statusText || 'Request failed';
            throw new Error(msg);
        }
        return data;
    }

    // Helper function to safely access DOM elements
    function getElement(selector) {
        const el = document.querySelector(selector);
        if (!el) {
            console.warn(`Element not found: ${selector}`);
        }
        return el;
    }

    // Escape dynamic text to avoid HTML injection
    function escapeHtml(text) {
        const span = document.createElement('span');
        span.textContent = text == null ? '' : String(text);
        return span.innerHTML;
    }

    function initEmojiPicker() {

    if (!emojiPicker || !emojiButton) return;

    // Emoji data by category
    const emojiCategories = {
        smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯'],
        people: ['👋', '🤚', '🖐', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁', '👅', '👄'],
        nature: ['🐵', '🐒', '🦍', '🦧', '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿', '🦔', '🦇'],
        food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭'],
        activities: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸', '🥌', '🎯', '🪀', '🪁', '🎮', '🕹', '🎲', '♟', '🎯', '🎳', '🎪', '🛝', '🎭', '🎨', '🧵', '🪡', '🧶', '🪢'],
        objects: ['⌚', '📱', '📲', '💻', '⌨️', '🖥', '🖨', '🖱', '🖲', '🕹', '🗜', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽', '🎞', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙', '🎚', '🎛', '🧭', '⏱', '⏲', '⏰', '🕰', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯', '🧯', '🪔', '🧱', '🪟'],
        symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️'],
        flags: ['🏳️', '🏴', '🏁', '🚩', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇫', '🇦🇽', '🇦🇱', '🇩🇿', '🇦🇸', '🇦🇩', '🇦🇴', '🇦🇮', '🇦🇶', '🇦🇬', '🇦🇷', '🇦🇲', '🇦🇼', '🇦🇺', '🇦🇹', '🇦🇿', '🇧🇸', '🇧🇭', '🇧🇩', '🇧🇧', '🇧🇾', '🇧🇪', '🇧🇿', '🇧🇯', '🇧🇲', '🇧🇹', '🇧🇴', '🇧🇦', '🇧🇼', '🇧🇷', '🇮🇴', '🇻🇬', '🇧🇳', '🇧🇬', '🇧🇫', '🇧🇮', '🇰🇭', '🇨🇲', '🇨🇦', '🇮🇨', '🇨🇻']
    };

    // Populate emoji grid
    function populateEmojiGrid(category = 'smileys') {
      const emojiGrid = emojiPicker.querySelector('.emoji-grid');
      emojiGrid.innerHTML = '';
      
      emojiCategories[category].forEach(emoji => {
        const button = document.createElement('button');
        button.className = 'emoji-item';
        button.textContent = emoji;
        button.setAttribute('aria-label', `Select ${emoji} emoji`);
        button.addEventListener('click', () => {
          if (messageInput) {
            messageInput.value += emoji;
            messageInput.focus();
            emojiPicker.classList.add('d-none');
          }
        });
        emojiGrid.appendChild(button);
      });
    }
  
    // Initialize with smileys
    populateEmojiGrid();
  
    // Category switching
    emojiPicker.querySelectorAll('.emoji-category-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const category = btn.dataset.category;
        emojiPicker.querySelectorAll('.emoji-category-btn').forEach(b => 
          b.classList.remove('active')
        );
        btn.classList.add('active');
        populateEmojiGrid(category);
      });
    });
  
    // Search functionality (optional, guarded)
    const searchInput = emojiPicker.querySelector('.emoji-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = (e.target.value || '').toLowerCase();
        if (!term) {
          const activeCategory = emojiPicker.querySelector('.emoji-category-btn.active');
          if (activeCategory) {
            populateEmojiGrid(activeCategory.dataset.category);
          }
          return;
        }
        const emojiGrid = emojiPicker.querySelector('.emoji-grid');
        emojiGrid.innerHTML = '';
        Object.values(emojiCategories).flat().forEach(emoji => {
          if (emoji.includes(term)) {
            const button = document.createElement('button');
            button.className = 'emoji-item';
            button.textContent = emoji;
            button.addEventListener('click', () => {
              if (messageInput) {
                messageInput.value += emoji;
                messageInput.focus();
                emojiPicker.classList.add('d-none');
              }
            });
            emojiGrid.appendChild(button);
          }
        });
      });
    }
  
    // Toggle picker visibility
    emojiButton.addEventListener('click', (e) => {
      e.stopPropagation();
      emojiPicker.classList.toggle('d-none');
      if (!emojiPicker.classList.contains('d-none')) {
        if (searchInput) { searchInput.value = ''; }
        populateEmojiGrid('smileys');
        emojiPicker.querySelector('.emoji-category-btn.active')?.classList.remove('active');
        emojiPicker.querySelector('.emoji-category-btn[data-category="smileys"]').classList.add('active');
      }
    });
  
    // Close picker when clicking outside
    document.addEventListener('click', (e) => {
      if (!emojiButton.contains(e.target) && !emojiPicker.contains(e.target)) {
        emojiPicker.classList.add('d-none');
      }
    });
  
    // Close button
    const closeBtn = emojiPicker.querySelector('.btn-close-emoji');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        emojiPicker.classList.add('d-none');
      });
    }
  }

    // Start chat button click handler
    // Initialize from server-provided session user
    currentUser = (window.CURRENT_USER && window.CURRENT_USER.emp_id) || null;
    if (currentUser) {
        if (chatContainer) chatContainer.style.display = 'block';
        if (currentUserSpan) currentUserSpan.textContent = `ID: ${currentUser}`;
        initializeChat(currentUser);
    }

    // Message send handlers
    if (sendButton) {
        sendButton.addEventListener('click', function() {
            if (currentGroup) {
                sendGroupMessage();
            } else {
                sendMessage();
            }
        });
    }

    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (currentGroup) {
                    sendGroupMessage();
                } else {
                    sendMessage();
                }
            }
        });
    }

    // Initialize chat
    function initializeChat(userId) {
        // Session-authenticated Socket.IO; prefer WebSocket transport with graceful fallback
        socket = io({
            transports: ['websocket', 'polling'],
            upgrade: true,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        // Handle offline/online status
        const offlineIndicator = document.getElementById('offlineIndicator');
        
        if (offlineIndicator) {
            window.addEventListener('online', () => {
                offlineIndicator.classList.remove('show');
                if (socket.disconnected) {
                    socket.connect();
                }
            });
            
            window.addEventListener('offline', () => {
                offlineIndicator.classList.add('show');
            });
            
            // Check initial status
            if (!navigator.onLine) {
                offlineIndicator.classList.add('show');
            }
        }

        // Desktop notification on message
        socket.on('notification', (data) => {
            const { title, body, senderId, messageId, url = '/' } = data;
        
            if (Notification.permission === "granted") {
                navigator.serviceWorker.getRegistration().then(reg => {
                    if (reg) {
                        reg.showNotification(title || 'New Message', {
                            body: body || 'You have a new message',
                            icon: '/static/images/notification-icon.png',
                            badge: '/static/images/badge-icon.png',
                            data: { url, senderId, messageId },
                            actions: [{ action: 'view', title: 'View', icon: '/static/images/view-icon.png' }]
                        });
                    }
                });
            }
        
            // ✅ Now this will work because showToast is global
            showToast(title, body);
        });        

        // Handle message from Service Worker (when notification clicked)
        if (navigator && navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
            navigator.serviceWorker.addEventListener('message', (event) => {
                const { type, senderId, messageId } = event.data || {};
                if (type === 'FOCUS_CHAT' && senderId) {
                    // Determine if this is a group or direct chat
                    if (String(senderId).startsWith('group_')) {
                        const gid = Number(String(senderId).replace('group_', ''));
                        if (!Number.isNaN(gid)) {
                            const ensureGroupThenFocus = () => {
                                const group = groupList.find(g => g.id === gid);
                                if (group) {
                                    switchToGroup(group.id, group.name, group.creator_id);
                                    // Mark the corresponding group item as active in the list for clarity
                                    try {
                                        const li = document.querySelector(`#group-list .group-item[data-group-id="${group.id}"]`);
                                        if (li) {
                                            document.querySelectorAll('#group-list .group-item').forEach(x => x.classList.remove('active'));
                                            li.classList.add('active');
                                        }
                                    } catch (_) {}
                                    highlightMessage(messageId);
                                } else {
                                    // Fallback: load groups and try again shortly
                                    loadGroups();
                                    setTimeout(ensureGroupThenFocus, 300);
                                }
                            };
                            ensureGroupThenFocus();
                        }
                    } else {
                        focusChatWith(senderId);
                        highlightMessage(messageId);
                    }
                }
            });
        }

        // Focus chat pane (helper)
        function focusChatWith(senderId) {
            // Example logic: simulate click on that user
            const userElem = document.querySelector(`[data-user-id="${senderId}"]`);
            if (userElem) userElem.click();
        }

        // Highlight specific message after opening
        function highlightMessage(messageId) {
            if (!messageId) return;
            setTimeout(() => {
                const messageElem = document.querySelector(`.message[data-message-id="${messageId}"]`);
                if (messageElem) {
                    messageElem.classList.add('highlighted');
                    messageElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => messageElem.classList.remove('highlighted'), 3000);
                }
            }, 1000); // Wait for message to be loaded
        }

        // Socket event handlers
        socket.on('connect', () => {
            loadOnlineUsers();
            // Load initial pin state
            fetch('/chat_pins', { credentials: 'same-origin' })
                .then(r => r.json()).then(pins => {
                    try {
                        (pins.users || []).forEach(id => pinnedUsers.add(String(id)));
                        (pins.groups || []).forEach(id => pinnedGroups.add(String(id)));
                        applyPinBadgesToLists();
                        resortUserList();
                        resortGroupList();
                    } catch (_) {}
                }).catch(() => {});
            if (offlineIndicator) offlineIndicator.classList.remove('show');
        });

        socket.on('disconnect', () => {
            if (offlineIndicator) offlineIndicator.classList.add('show');
        });

        socket.on('connect_error', (err) => {
            try { console.warn('Socket connect_error:', err?.message || err); } catch (_) {}
        });

        socket.on('update_last_activity', (data) => {
            try {
                const peerId = data && (data.peer_id || data.user_id);
                const ts = toMillis(data && (data.timestamp || data.ts || Date.now()));
                if (!peerId) return;
                if (ts > 0) {
                    userLastDirectTs.set(String(peerId), ts);
                    scheduleResortUserList();
                }
            } catch (_) {}
        });

        socket.on('update_group_activity', (data) => {
            // Sorting removed; placeholder retained for future logic
        });

        socket.on('unread_counts_update', (counts) => {
            const fresh = {};
            const normalized = counts && typeof counts === 'object' ? counts : {};
            
            // Seed all currently known/direct/group keys to zero
            document.querySelectorAll('.user-item').forEach(item => {
                if (item && item.dataset && item.dataset.userId) {
                    fresh[item.dataset.userId] = 0;
                }
            });
            document.querySelectorAll('.group-item').forEach(item => {
                if (item && item.dataset && item.dataset.groupId) {
                    fresh[`group_${item.dataset.groupId}`] = 0;
                }
            });
            Object.keys(unreadCounts || {}).forEach(k => { if (!(k in fresh)) fresh[k] = 0; });
            
            // Apply incoming values
            Object.entries(normalized).forEach(([key, value]) => {
                const n = Number(value) || 0;
                fresh[key] = n;
            });
            
            unreadCounts = fresh;
            updateAllUnreadCounts();

            // Resort lists quickly using caches (no heavy recompute)
            scheduleResortUserList();
            resortGroupList();
        });

        // ✅ CRITICAL FIX: Improved new_message handler with proper read receipt flow
        socket.on('new_message', (message) => {
            const exists = document.querySelector(`[data-message-id="${message.id}"]`);
            if (exists) return;
            
            if ((message.sender_id === currentUser && message.receiver_id === currentReceiver) ||
                (message.sender_id === currentReceiver && message.receiver_id === currentUser)) {
                appendMessage(message);
                
                // ✅ FIXED: Only mark as read if it's a received message and we're viewing the chat
                // This triggers the real-time read receipt
                if (message.receiver_id === currentUser && currentReceiver === message.sender_id) {
                    // Immediate read receipt for real-time viewing
                    socket.emit('mark_read', {
                        message_id: message.id,
                        receiver_id: currentUser,
                        sender_id: message.sender_id
                    });
                }
            }
            
            // Notifications for direct messages: only when not viewing the chat or window not focused, and message is not already marked read
            if (message.receiver_id === currentUser && message.sender_id !== currentUser) {
                const isViewingChat = currentReceiver === message.sender_id;
                const windowInactive = !document.hasFocus() || document.visibilityState === 'hidden';
                if ((!isViewingChat || windowInactive) && !message.is_read) {
                    showNewMessageNotification(message);
                }

                // Delivery ack for direct messages when not actively viewing
                if (!isViewingChat) {
                    if (!message.group_id) {
                        socket.emit('message_delivered', { message_id: message.id, sender_id: message.sender_id });
                    }
                }
            }

            // Update ordering: recent activity first regardless of presence
            // Also update unread counts in real-time (visual only)
            if (message.receiver_id === currentUser) {
                const currentUnread = unreadCounts[message.sender_id] || 0;
                unreadCounts[message.sender_id] = currentUnread + 1;
                updateAllUnreadCounts();
            }
            
            // Force one more reordering to ensure everything is sorted by activity
            // Update per-user last message time cache
            const peerId = message.sender_id === currentUser ? message.receiver_id : message.sender_id;
            const ts = toMillis(message.timestamp || message.created_at || Date.now());
            if (ts > 0) userLastDirectTs.set(peerId, ts);

            // Resort user list efficiently
            scheduleResortUserList();

            // Also emit local last-activity update to ensure immediate reordering for sender
            try {
                const tnow = toMillis(message.timestamp || Date.now());
                const peer = message.sender_id === currentUser ? message.receiver_id : message.sender_id;
                if (tnow > 0 && peer) {
                    userLastDirectTs.set(String(peer), tnow);
                    scheduleResortUserList();
                }
            } catch (_) {}
        });

        // Also add this to handle initial page load
        document.addEventListener('DOMContentLoaded', function() {
            // Wait for the initial data to load
            setTimeout(() => {
                initGroupMemberSearch();
            }, 1000);
            
            // Add periodic reordering every 30 seconds to catch any missed updates
            setInterval(() => {
                // Sorting removed
            }, 30000);
        });
        
        // Add this function to show notifications via Service Worker (best practice)
        function showNewMessageNotification(message) {
            // Skip if current view already covers the conversation and window is focused
            if (document.hasFocus() && ((currentReceiver === message.sender_id) || (currentGroup && message.group_id === currentGroup))) return;
            if (!('Notification' in window) || Notification.permission !== 'granted') return;

            const senderName = message.sender_name || 'Unknown';
            const isGroup = !!message.group_id;
            // Try to resolve group name from local cache
            const groupName = isGroup ? ((groupList.find(g => g.id === message.group_id) || {}).name || `Group ${message.group_id}`) : null;

            let bodyText = message.content || '';
            const msgType = message.type || message.message_type;
            if (msgType === 'image') bodyText = isGroup ? `${senderName}: 📷 Sent an image` : '📷 Sent an image';
            if (msgType === 'file') bodyText = isGroup ? `${senderName}: 📎 Sent a file` : '📎 Sent a file';
            if (bodyText && bodyText.length > 80) bodyText = bodyText.slice(0, 80) + '…';

            navigator.serviceWorker.getRegistration().then(reg => {
                if (!reg) return;
                const title = isGroup ? `New message in ${groupName}` : `New message from ${senderName}`;
                reg.showNotification(title , {
                    body: bodyText || 'You have a new message',
                    icon: '/static/images/notification-icon.png',
                    badge: '/static/images/badge-icon.png',
                    tag: `message-${message.id}`,
                    requireInteraction: false,
                    data: {
                        url: window.location.href.split('?')[0],
                        senderId: message.group_id ? `group_${message.group_id}` : message.sender_id,
                        messageId: message.id
                    },
                    actions: [{ action: 'view', title: 'View', icon: '/static/images/view-icon.png' }]
                });
            });
        }
    
        socket.on('user_connected', (data) => {
            updateUserStatus(data.user_id, true);
        });
        
        socket.on('user_disconnected', (data) => {
            updateUserStatus(data.user_id, false);
        });

        // React to pin changes from server
        socket.on('chat_pin_updated', (evt) => {
            const { target_type, target_id, pin } = evt || {};
            if (target_type === 'user') {
                if (pin) pinnedUsers.add(String(target_id)); else pinnedUsers.delete(String(target_id));
                applyPinBadgeToUser(String(target_id), !!pin);
                resortUserList();
            } else if (target_type === 'group') {
                const gid = String(target_id);
                if (pin) pinnedGroups.add(gid); else pinnedGroups.delete(gid);
                applyPinBadgeToGroup(gid, !!pin);
                resortGroupList();
            }
        });

        // Group chat real-time events
        socket.on('group_created', (group) => {
            if (!groupList.some(g => g.id === group.id)) {
                groupList.push(group);
                renderGroupList();
                // Auto-join the newly created group room to receive real-time events
                if (socket && group && group.id != null) {
                    socket.emit('join_group', { group_id: group.id });
                }
            }
        });
        
        socket.on('new_group_message', (message) => {
            if (message.group_id == currentGroup) {
                appendGroupMessage(message);
                
                // Update group last activity cache
                const ts = Date.parse(message.timestamp || message.created_at || new Date().toISOString());
                if (!isNaN(ts)) groupLastActivityTs.set(String(message.group_id), ts);
                
                // Mark as seen if it's a received message and we're viewing the group
                if (message.sender_id !== currentUser) {
                    socket.emit('mark_group_message_seen', {
                        message_id: message.id,
                        group_id: message.group_id
                    });
                }
            }
            
            // Sorting removed
            // Update group last activity cache and resort
            {
                const ts = toMillis(message.timestamp || message.created_at || Date.now());
                if (ts > 0) groupLastActivityTs.set(String(message.group_id), ts);
            }
            resortGroupList();
            
            // Update unread counts in real-time for groups
            if (message.sender_id !== currentUser) {
                const groupKey = `group_${message.group_id}`;
                const currentUnread = unreadCounts[groupKey] || 0;
                unreadCounts[groupKey] = currentUnread + 1;
                updateAllUnreadCounts();
                sortGroupListByPolicy();

                // Show notification if user not viewing this group or window not focused
                const isViewingGroup = currentGroup === message.group_id;
                const windowInactive = !document.hasFocus() || document.visibilityState === 'hidden';
                if ((!isViewingGroup || windowInactive)) {
                    showNewMessageNotification(message);
                }
            }
        });
        
        socket.on('group_message_seen_update', (data) => {
            // Update seen status UI
            const messageId = data.message_id;
            const seenUsers = data.seen_users;
            
            // Update seen status UI
            const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
            if (messageElement) {
                messageElement.classList.add('seen');
            }
        });
    }

    function sendMessage() {
        if (sending) return;
        const content = messageInput?.value.trim();
        if ((!content && !currentImageData && !pendingAttachments.length) || !currentReceiver) return;

        if (pendingAttachments.length > 1 || (pendingAttachments.length === 1 && currentImageData)) {
            return sendDirectWithAttachments(content);
        }

        sending = true;
        let messageData = {
            sender_id: currentUser,
            receiver_id: currentReceiver,
            content: content || '',
            filename: currentImageData ? currentImageData.name : '',
            type: replyingTo ? 'reply' : (currentImageData ? ((currentImageData.type || '').startsWith('image/') ? 'image' : 'file') : 'text'),
            parent_message_id: replyingTo
        };
        if (currentImageData) {
            const previewContainer = document.getElementById('image-preview-container');
            if (previewContainer) {
                previewContainer.innerHTML = `<div class="attachment-preview loading"><i class="fas fa-image fa-spin"></i><span class="file-name">${currentImageData.name}</span><div class="loading-text">Sending...</div></div>`;
            }
            messageData.media_url = currentImageData.data;
        }
        socket.emit('send_message', messageData, (response) => {
            sending = false;
            if (response && response.error) {
                alert('Failed to send message: ' + response.error);
                if (currentImageData) {
                    updateImagePreview(currentImageData.data);
                }
            } else {
                if (messageInput) messageInput.value = '';
                if (currentImageData) {
                    currentImageData = null;
                    pendingAttachments = [];
                    clearAttachmentsPreview();
                }
                if (replyingTo) {
                    cancelReply();
                }
                // Sorting removed
            }
        });
    }

    function sendDirectWithAttachments(content) {
        if (sending) return;
        const queue = pendingAttachments.slice();
        const hasText = !!(content && content.trim());
        let index = 0;
        sending = true;
        const sendNext = () => {
            if (index >= queue.length) {
                sending = false;
                pendingAttachments = [];
                currentImageData = null;
                clearAttachmentsPreview();
                if (messageInput) messageInput.value = '';
                if (replyingTo) cancelReply();
                // Sorting removed
                return;
            }
            const att = queue[index];
            const isImage = (att.type || '').startsWith('image/');
            const messageData = {
                sender_id: currentUser,
                receiver_id: currentReceiver,
                content: (index === 0 && hasText) ? content : '',
                filename: att.name || '',
                type: replyingTo ? 'reply' : (isImage ? 'image' : 'file'),
                parent_message_id: replyingTo,
                media_url: att.data
            };
            socket.emit('send_message', messageData, (response) => {
                if (response && response.error) {
                    sending = false;
                    try { showToast('Error', 'Failed to send one of the attachments'); } catch (_) {}
                    return;
                }
                index++;
                sendNext();
            });
        };
        sendNext();
    }

    // File size constants
    const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16MB in bytes
    // Allow only jpeg/jpg and png for images; and selected document types
    const ALLOWED_MIME_TYPES = [
        'image/jpeg', 'image/png',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];

    function handleImageUpload(e) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        addFilesToQueue(files);
        e.target.value = '';
    }

    function addFilesToQueue(files) {
        const validFiles = [];
        files.forEach(file => {
            if (!file) return;
            const type = file.type || '';
            if (!(type.startsWith('image/') || ALLOWED_MIME_TYPES.includes(type))) return;
            if (file.size > MAX_FILE_SIZE) return;
            validFiles.push(file);
        });
        if (!validFiles.length) return;

        validFiles.forEach(file => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const att = { name: file.name, type: file.type, data: event.target.result };
                pendingAttachments.push(att);
                currentImageData = att; // maintain existing single-attachment behavior
                updateAttachmentsPreview();
            };
            reader.onerror = () => { try { showToast('Error', `Failed to read ${file.name}`); } catch (_) {} };
            reader.readAsDataURL(file);
        });
    }

    function formatBytes(bytes) {
        if (!bytes && bytes !== 0) return '';
        const units = ['B','KB','MB','GB','TB'];
        let i = 0;
        let num = bytes;
        while (num >= 1024 && i < units.length - 1) {
            num /= 1024; i++;
        }
        return `${num.toFixed(num < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
    }

    function getFileIconClass(name) {
        const ext = (name || '').split('.').pop().toLowerCase();
        if (['jpg','jpeg','png'].includes(ext)) return 'fas fa-file-image text-primary';
        if (ext === 'pdf') return 'fas fa-file-pdf text-danger';
        if (['doc','docx'].includes(ext)) return 'fas fa-file-word text-primary';
        if (['xls','xlsx'].includes(ext)) return 'fas fa-file-excel text-success';
        return 'fas fa-file text-muted';
    }

    function updateImagePreview(imageData) {
        // Map legacy single preview calls to multi-attachments preview
        if (imageData) {
            if (!pendingAttachments.length && currentImageData) pendingAttachments = [currentImageData];
            updateAttachmentsPreview();
        } else {
            clearAttachmentsPreview();
        }
    }

    function updateAttachmentsPreview() {
        let previewContainer = document.getElementById('image-preview-container');
        if (!previewContainer) {
            previewContainer = document.createElement('div');
            previewContainer.id = 'image-preview-container';
            const inputGroup = document.querySelector('.input-group');
            if (inputGroup) {
                inputGroup.insertBefore(previewContainer, messageInput);
            }
        }
        if (!pendingAttachments.length) {
            clearAttachmentsPreview();
            return;
        }
        const items = pendingAttachments.map((att, idx) => {
            const isImage = (att.type || '').startsWith('image/');
            return `
                <div class="attachment-preview" data-idx="${idx}">
                    <i class="fas ${isImage ? 'fa-image' : 'fa-paperclip'}"></i>
                    <span class="file-name">${att.name || 'Attachment'}</span>
                    <button type="button" class="btn-close" data-remove-idx="${idx}"></button>
                </div>
            `;
        }).join('');
        previewContainer.innerHTML = items;
        previewContainer.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-remove-idx]');
            if (!btn) return;
            const idx = parseInt(btn.getAttribute('data-remove-idx'), 10);
            if (!isNaN(idx)) {
                pendingAttachments.splice(idx, 1);
                currentImageData = pendingAttachments[pendingAttachments.length - 1] || null;
                updateAttachmentsPreview();
            }
        }, { once: true });
        if (messageInput) {
            const last = pendingAttachments[pendingAttachments.length - 1];
            const isImage = (last?.type || '').startsWith('image/');
            messageInput.placeholder = isImage ? 'Add a message or send image(s)...' : 'Add a message or send file(s)...';
        }
    }

    function clearAttachmentsPreview() {
        const previewContainer = document.getElementById('image-preview-container');
        if (previewContainer) previewContainer.remove();
        if (messageInput) messageInput.placeholder = 'Type your message...';
    }

    function removeImagePreview() {
        pendingAttachments = [];
        currentImageData = null;
        updateImagePreview(null);
    }

    if (imageUpload) {
        imageUpload.addEventListener('change', handleImageUpload);
    }

    // Add drag and drop support for images
    const dropZone = document.querySelector('.messages-container');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (files.length > 0) {
                addFilesToQueue(Array.from(files));
            }
        });
    }

    // Track last interacted message for Alt+R
    if (messagesContainer) {
        messagesContainer.addEventListener('click', (e) => {
            const msg = e.target.closest('.message');
            if (msg && msg.dataset && msg.dataset.messageId) {
                lastInteractedMessageId = msg.dataset.messageId;
            }
        });
    }

    // Paste-to-upload support (images and allowed document types)
    function handlePasteEvent(e) {
        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData) return;

        // Prefer DataTransferItemList when available to inspect types
        const items = clipboardData.items ? Array.from(clipboardData.items) : [];
        let file = null;

        if (items.length) {
            // Find the first file item with an allowed type
            for (const item of items) {
                if (item.kind !== 'file') continue;
                const blob = item.getAsFile();
                if (!blob) continue;
                const type = blob.type || '';
                const isAllowed = type.startsWith('image/') || (ALLOWED_MIME_TYPES || []).includes(type);
                if (isAllowed) {
                    // Ensure a filename exists for downstream UI
                    const name = blob.name && blob.name.trim() ? blob.name : (type.startsWith('image/') ? 'pasted-image.png' : 'pasted-file');
                    try {
                        file = new File([blob], name, { type: type || 'application/octet-stream' });
                    } catch (_) {
                        // Fallback for older browsers that may not support File constructor
                        blob.name = name;
                        file = blob;
                    }
                    break;
                }
            }
        }

        // Fallback: some browsers expose files directly on clipboardData.files
        if (!file && clipboardData.files && clipboardData.files.length) {
            const candidate = clipboardData.files[0];
            const type = candidate.type || '';
            const isAllowed = type.startsWith('image/') || (ALLOWED_MIME_TYPES || []).includes(type);
            if (isAllowed) {
                file = candidate;
            }
        }

        if (file) {
            e.preventDefault();
            addFilesToQueue([file]);
        }
    }

    if (messageInput) {
        messageInput.addEventListener('paste', handlePasteEvent);
    }

    // Format message time
    function formatMessageTime(timestamp) {
        if (!timestamp) return '';
        
        const date = new Date(timestamp); // ISO string → local time auto
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.floor((today - messageDay) / (1000 * 60 * 60 * 24));
    
        let timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    
        if (today.getTime() === messageDay.getTime()) {
            return timeStr;
        } else if (diffDays === 1) {
            return `Yesterday, ${timeStr}`;
        } else {
            return `${date.toLocaleDateString('en-GB')}, ${timeStr}`;
        }
    }    

    function formatSeenTime(isoString) {
        if (!isoString) return '';
        
        const date = new Date(isoString);
        return date.toLocaleString([], {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    // Message creation helpers
    function createMessageHeader(message) {
        if (!message.message_type && !message.type) return '';
        
        const messageType = message.message_type || message.type;
        const headerIcon = message.header_icon || (messageType === 'reply' ? 'fa-reply' : 'fa-share');
        
        // Updated header text for forwarded messages
        const headerText = message.message_header || 
            (messageType === 'forward' ? `Forwarded from ${message.sender_name || 'User'}` : 
             `Reply to ${message.parent_sender_name || 'User'}`);
        
        const headerClass = messageType === 'reply' ? 'reply-header' : 'forward-header';
        
        return `
            <div class="${headerClass}">
                <i class="fas ${headerIcon}"></i> ${headerText}
            </div>
        `;
    }

    function createReplyContent(message) {
        let replyHtml = '';
        const messageType = message.message_type || message.type;
        
        if (messageType === 'reply' && message.parent_message_id) {
            // Get parent content from message data
            let parentContent = message.parent_content;
            let parentType = message.parent_message_type;
            let parentMediaUrl = message.parent_media_url;
            let parentSenderName = message.parent_sender_name || 'User';

            if (!parentContent && !parentMediaUrl) {
                parentContent = 'Original message not available';
                parentType = 'text';
            }

            const headerHtml = `
                <div class="reply-header">
                    <i class="fas fa-reply"></i> Reply to ${parentSenderName}
                </div>
            `;

            let contentHtml = '';
            if (parentType === 'image') {
                contentHtml = `
                    <div class="reply-attachment" onclick="highlightOriginalMessage(${message.parent_message_id})">
                        <i class="fas fa-image"></i>
                        <span class="file-name">${parentContent || 'Image attachment'}</span>
                    </div>
                `;
            } else {
                contentHtml = `<div class="reply-text" onclick="highlightOriginalMessage(${message.parent_message_id})">${parentContent}</div>`;
            }
            
            replyHtml = `
                <div class="replied-to" data-parent-id="${message.parent_message_id}">
                    ${headerHtml}
                    <div class="reply-content">
                        ${contentHtml}
                    </div>
                </div>
            `;
        }
        return replyHtml;
    }

    // Update the highlightOriginalMessage function in chat.js
    window.highlightOriginalMessage = function(messageId) {
        // First remove any existing highlights
        document.querySelectorAll('.message.highlighted').forEach(el => {
            el.classList.remove('highlighted');
        });

        const originalMessage = document.querySelector(`[data-message-id="${messageId}"]`);
        if (originalMessage) {
            originalMessage.classList.add('highlighted');
            
            // Scroll to the message with some padding
            const messagesContainer = document.getElementById('messages');
            if (messagesContainer) {
                const containerHeight = messagesContainer.clientHeight;
                const messageTop = originalMessage.offsetTop;
                const messageHeight = originalMessage.offsetHeight;
                
                messagesContainer.scrollTo({
                    top: messageTop - (containerHeight / 2) + (messageHeight / 2),
                    behavior: 'smooth'
                });
            }

            // Remove highlight after animation completes
            setTimeout(() => {
                originalMessage.classList.remove('highlighted');
            }, 2000);
        }
    };

    function appendMessage(message) {
        if (!messagesContainer) return;
    
        // Final safety check - prevent duplicates in case of any edge cases
        const existingMessage = document.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMessage) {
            console.warn('Duplicate message prevented - already exists in DOM:', message.id);
            return;
        }
        
        const messageElement = document.createElement('div');
        messageElement.className = `message ${message.sender_id === currentUser ? 'sent' : 'received'}`;
        messageElement.dataset.messageId = message.id;
        messageElement.dataset.timestamp = message.timestamp || message.created_at;
        messageElement.dataset.type = message.type || message.message_type;
        if (message.parent_message_id) {
            messageElement.dataset.parentMessageId = message.parent_message_id;
        }
        
        // ✅ FIXED: Proper read status handling
        if (message.is_read) {
            messageElement.classList.add('read');
        }
        
        let contentHtml = '';
        const messageType = message.type || message.message_type;
        
        if (messageType === 'reply') {
            contentHtml += createReplyContent(message);
        }
        
        if (messageType === 'forward') {
            contentHtml += `<div class="forwarded">${createMessageHeader(message)}</div>`;
            if (message.media_url && (message.media_type === 'image' || (message.media_url.match(/\.(jpg|jpeg|png)$/i)))) {
                let fullImageUrl = message.media_url;
                if (!fullImageUrl.startsWith('/static/')) {
                    fullImageUrl = `/static/${fullImageUrl.replace(/^\/*/, '')}`;
                }
                if (!imageGallery.includes(fullImageUrl)) imageGallery.push(fullImageUrl);
                let fileName = message.filename || 'Attachment';
                contentHtml += `<div class="image-message-block">
                    <div class="message-attachment" data-image-url="${fullImageUrl}">
                        <i class="fas fa-paperclip"></i>
                        <span class="file-name">${fileName}</span>
                    </div>
                </div>`;
            } else {
                // Non-image forwarded attachment or text
                if (message.media_url && message.media_type === 'file') {
                    const fileName = message.filename || 'Attachment';
                    contentHtml += `<div class="file-attachment">
                        <div class="file-thumb">
                            <i class="${getFileIconClass(fileName)}"></i>
                        </div>
                        <div class="file-meta">
                            <div class="file-name" title="${fileName}">${fileName}</div>
                            ${message.file_size ? `<div class="file-size">${formatBytes(message.file_size)}</div>` : ''}
                            <div class="file-actions">
                                <a href="/download/${message.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                                <a href="/download/${message.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                            </div>
                        </div>
                    </div>`;
                } else {
                    contentHtml += `<p>${message.content}</p>`;
                }
            }
        } else if (messageType === 'image' && message.media_url) {
            let fullImageUrl = message.media_url;
            if (!fullImageUrl.startsWith('/static/')) {
                fullImageUrl = `/static/${fullImageUrl.replace(/^\/*/, '')}`;
            }
            if (!imageGallery.includes(fullImageUrl)) imageGallery.push(fullImageUrl);
            const hasText = message.content && message.content.trim() && message.content !== message.media_url;
            let fileName = message.filename || 'Attachment';
            contentHtml += `<div class="image-message-block">`;
            if (hasText) {
                contentHtml += `<div class="image-message-text">${message.content}</div>`;
            }
            contentHtml += `
                <div class="message-attachment" data-image-url="${fullImageUrl}">
                    <i class="fas fa-paperclip"></i>
                    <span class="file-name">${fileName}</span>
                </div>
            </div>`;
        } else if (messageType === 'file' && message.media_url) {
            const fullFileUrl = message.media_url.startsWith('/static/') ? message.media_url : `/static/${message.media_url}`;
            const fileName = message.filename || 'Attachment';
            contentHtml += `<div class="file-attachment">
                <div class="file-thumb">
                    <i class="${getFileIconClass(fileName)}"></i>
                </div>
                <div class="file-meta">
                    <div class="file-name" title="${fileName}">${fileName}</div>
                    ${message.file_size ? `<div class="file-size">${formatBytes(message.file_size)}</div>` : ''}
                    <div class="file-actions">
                        <a href="/download/${message.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                        <a href="/download/${message.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                    </div>
                </div>
            </div>`;
            if (message.content && message.content.trim() && message.content !== message.media_url) {
                contentHtml += `<p>${message.content}</p>`;
            }
        } else {
            contentHtml += `<p>${message.content}</p>`;
        }
        
        const timestamp = message.timestamp || message.created_at;
        const formattedTime = formatMessageTime(timestamp);
        const isDirectSent = !message.group_id && message.sender_id === currentUser;
        
        // ✅ FIXED: Correct status logic for real-time updates
        let statusHtml = '';
        if (isDirectSent) {
            if (message.is_read) {
                statusHtml = '<span class="status read">✓✓</span>'; // Green - read
            } else {
                // Check if we have delivery confirmation but not read confirmation
                statusHtml = '<span class="status">✓✓</span>'; // Grey - delivered but not read
            }
        }
        
        if (message.group_id) {
            contentHtml += `<span class="seen-status-eye" data-message-id="${message.id}" style="cursor:pointer; margin-left:8px;"><i class="fas fa-eye"></i></span>`;
        }
        
        let pinnedLabel = message.pinned ? `<span class="pinned-label badge bg-warning text-dark ms-2" title="Pinned"><i class="fas fa-thumbtack"></i> Pinned</span>` : '';
    
        messageElement.innerHTML = `
            <div class="content">
                ${contentHtml}
                <div class="message-actions">
                    <button onclick="handleReply(${message.id})" class="btn btn-sm" title="Reply to this message">
                        <i class="fas fa-reply"></i>
                    </button>
                    <button onclick="handleForward(${message.id})" class="btn btn-sm" title="Forward this message">
                        <i class="fas fa-share"></i>
                    </button>
                    <button onclick="handlePin('${message.id}')" class="btn btn-sm pin-btn${message.pinned ? ' pinned' : ''}" title="${message.pinned ? 'Unpin this message' : 'Pin this message'}">
                        <i class="fas fa-thumbtack${message.pinned ? ' text-warning' : ''}"></i>
                    </button>
                </div>
                <span class="sender-name d-none">${message.sender_name}</span>
            </div>
            <div class="metadata">
                <span class="time" title="${new Date(timestamp).toLocaleString()}">${formattedTime}</span>${statusHtml}
                ${pinnedLabel}
            </div>
        `;
                
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
        // ✅ CRITICAL FIX: Immediately mark received messages as read when viewing the chat
        if (message.receiver_id === currentUser && !message.is_read && currentReceiver === message.sender_id) {
            // This message is for the current user and they're viewing the chat - mark as read immediately
            socket.emit('mark_read', {
                message_id: message.id,
                receiver_id: currentUser,
                sender_id: message.sender_id
            });
        }
    
        if (message.pinned) {
            updatePinUI(message.id, true);
        }
    }

    function loadMessages(senderId, receiverId) {
        if (!messagesContainer) return;
        // Increment request id so stale responses are ignored
        const reqId = ++directMessagesRequestId;
        messagesContainer.innerHTML = '';
        fetchJSON(`/messages/${senderId}/${receiverId}`)
            .then(messages => {
                if (reqId !== directMessagesRequestId) return; // Ignore outdated response
                if (!Array.isArray(messages)) return;
                // Ensure container is clean before render
                messagesContainer.innerHTML = '';
                messages.reverse().forEach(message => {
                    appendMessage(message);
                    
                    // ✅ FIXED: Only mark as read if it's a received message that's unread AND we're viewing the chat
                    if (message.receiver_id === currentUser && !message.is_read && currentReceiver === message.sender_id) {
                        // This ensures read receipts are sent when loading historical messages
                        socket.emit('mark_read', {
                            message_id: message.id,
                            receiver_id: currentUser,
                            sender_id: message.sender_id
                        });
                    }
                });
            })
            .catch(err => {
                try { showToast('Error', err.message || 'Failed to load messages'); } catch (_) {}
            });
    }

    function loadOnlineUsers() {
        if (!currentUser) return;
        
        fetchJSON(`/online_users`)
            .then(users => {
                if (!Array.isArray(users)) return;
                const list = document.getElementById('active-users-list');
                if (!list) return;
                
                users.forEach(u => {
                    const li = list.querySelector(`.user-item[data-user-id="${u.user_id}"]`);
                    if (!li) return;
                    
                    // Seed last_direct_msg cache if supplied
                    if (u.last_direct_msg) {
                        const t = Date.parse(u.last_direct_msg);
                        if (!isNaN(t)) userLastDirectTs.set(u.user_id, t);
                    }
                    
                    // Update both data attribute and visual status
                    li.dataset.isOnline = String(!!u.is_online);
                    updateUserStatus(u.user_id, !!u.is_online);
                    updateUnreadCount(u.user_id, u.unread_count || 0);
                });
                
                // Initial resort after data seed
                resortUserList();
            })
            .catch(() => {});
    }

    function updateUnreadCount(userId, count) {
        const userElement = document.querySelector(`[data-user-id="${userId}"]`);
        if (userElement) {
            const countElement = userElement.querySelector('.unread-count');
            if (countElement) {
                if (count > 0) {
                    countElement.textContent = count;
                    countElement.style.display = 'inline-block';
                    countElement.classList.remove('hide');
                } else {
                    // Immediately hide when count is zero
                    countElement.textContent = '';
                    countElement.classList.add('hide');
                    countElement.style.display = 'none';
                }
            }
        }
    }

    function hideChatStatus() {
        const statusElement = document.getElementById('chatWithStatus');
        if (statusElement) {
            statusElement.textContent = '';
            statusElement.className = 'text-muted small d-none';
        }
    }

    function updateChatWithStatus(userId) {
        // Only show presence in direct chats for the active peer
        if (!userId || currentGroup || !currentReceiver || currentReceiver !== userId) {
            hideChatStatus();
            return;
        }
        fetchJSON(`/user_status/${userId}`)
            .then(data => {
                const statusElement = document.getElementById('chatWithStatus');
                // Re-validate context to avoid stale updates
                if (!statusElement || currentGroup || currentReceiver !== userId) {
                    hideChatStatus();
                    return;
                }
                if (!data || !data.status) {
                    hideChatStatus();
                    return;
                }
                const status = String(data.status).toLowerCase();
                statusElement.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                statusElement.className = `text-muted small status-${status}`;
            })
            .catch(() => { hideChatStatus(); });
    }

    // Event listeners
    if (activeUsersList) {
        activeUsersList.addEventListener('click', (e) => {
            const userItem = e.target.closest('.user-item');
            if (userItem && userItem.dataset && userItem.dataset.userId) {
                // Single entry point to switch chats and load messages
                switchToUser(userItem.dataset.userId);
            }
        });
    }

    if (uploadButton) {
        uploadButton.addEventListener('click', () => {
            imageUpload?.click();
        });
    }

    // Reply preview element
    const replyPreview = document.createElement('div');
    replyPreview.id = 'reply-preview';
    replyPreview.className = 'reply-preview d-none';
    const cardFooter = document.querySelector('.card-footer');
    if (cardFooter) {
        cardFooter.insertBefore(replyPreview, document.querySelector('.input-group'));
    }

    const forwardModal = new bootstrap.Modal(document.getElementById('forwardModal'));

    // Enhanced reply handling
    window.handleReply = (messageId) => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageElement) return;

        const contentElement = messageElement.querySelector('.content');
        if (!contentElement) return;

        replyingTo = messageId;
        
        let previewContent = '';
        const messageType = messageElement.dataset.type;
        const senderName = messageElement.querySelector('.sender-name')?.textContent || 'User';
        
        let messageContent = '';
        if (messageType === 'image' || messageType === 'file') {
            const attachment = contentElement.querySelector('.message-attachment');
            if (attachment) {
                previewContent = `
                    <div class="reply-attachment">
                        <i class="fas ${messageType === 'image' ? 'fa-image' : 'fa-file'}"></i>
                        <span class="file-name">${attachment.querySelector('.file-name').textContent}</span>
                    </div>
                `;
                messageContent = attachment.querySelector('.file-name').textContent;
            }
        } else {
            const textContent = contentElement.querySelector('p:not(.reply-content):not(.forward-content)');
            if (textContent) {
                messageContent = textContent.textContent;
                previewContent = `<p>${messageContent}</p>`;
            }
        }
        
        if (replyPreview) {
            replyPreview.innerHTML = `
                <div class="reply-preview-content">
                    <div class="reply-preview-header">
                        <div>
                            <i class="fas fa-reply"></i>
                            Replying to ${senderName}
                        </div>
                        <button type="button" class="btn-close" onclick="cancelReply()" aria-label="Cancel reply"></button>
                    </div>
                    <div class="reply-preview-message">${previewContent}</div>
                </div>
            `;
            replyPreview.classList.remove('d-none');
            if (messageInput) messageInput.focus();
        }
    };

    window.cancelReply = () => {
        replyingTo = null;
        if (replyPreview) {
            replyPreview.classList.add('d-none');
            replyPreview.innerHTML = '';
        }
    };

    // Enhanced forward handling
    window.handleForward = (messageId) => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.content');
        if (!contentElement) return;
        const forwardMessageContent = contentElement.innerHTML;
        const userList = document.getElementById('forward-users-list');
        
        if (!userList) return;
        
        // Clear previous content
        userList.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary" ><span class="visually-hidden">Loading...</span></div></div>';
        
        // Always add direct message recipients section
        const directUsersSection = document.createElement('div');
        directUsersSection.innerHTML = '<h6 class="fw-bold mb-2">Direct Messages</h6>';
        userList.appendChild(directUsersSection);
        
        // Add direct message users (including current user once, label self)
        const seenUserIds = new Set();
        Array.from(document.querySelectorAll('.user-item'))
            .forEach(item => {
                const userId = item.dataset.userId;
                if (!userId || seenUserIds.has(userId)) return;
                seenUserIds.add(userId);
                const rawName = item.querySelector('.user-name-text')?.textContent || '';
                // Normalize any existing "(You)" markers coming from the sidebar
                const cleanName = rawName
                    .replace(/^\(You\)\s*/i, '')
                    .replace(/\s*\(You\)$/i, '')
                    .trim();
                const isSelf = userId === currentUser;
                
                const userDiv = document.createElement('div');
                userDiv.className = 'form-check';
                userDiv.innerHTML = `
                    <input class="form-check-input" type="checkbox" value="${userId}" 
                        id="forward-user-${userId}">
                    <label class="form-check-label" for="forward-user-${userId}">
                        <span class="user-name-text">${cleanName}${isSelf ? ' (You)' : ''}</span>
                        <small class="text-muted ms-2"></small>
                    </label>
                `;
                directUsersSection.appendChild(userDiv);
            });
        
        // Create groups section (will be populated after loading)
        const groupsSection = document.getElementById('forward-groups-list');
        if (groupsSection) {
            groupsSection.innerHTML = '';
        }
        
        // Load groups for the current user (session-based)
        fetch(`/groups`)
            .then(res => res.json())
            .then(groups => {
                const groupsList = document.getElementById('forward-groups-list');
                if (!groupsList) return;
                
                if (groups.length > 0) {
                groups.forEach(group => {
                        const groupDiv = document.createElement('div');
                        groupDiv.className = 'form-check';
                        groupDiv.innerHTML = `
                            <input class="form-check-input" type="checkbox" value="group_${group.id}" 
                                id="forward-group-${group.id}">
                            <label class="form-check-label" for="forward-group-${group.id}">
                                <span class="group-name-text">${group.name}</span>
                                <small class="text-muted ms-2"></small>
                            </label>
                        `;
                        groupsList.appendChild(groupDiv);
                    });
                } else {
                    groupsList.innerHTML = '<div class="text-muted small">No groups available</div>';
                }
                
                // Remove loading spinner
                const loadingElement = userList.querySelector('.text-center.py-3');
                if (loadingElement) {
                    loadingElement.remove();
                }

                // Wire select-all toggles for forward modal
                const selUsers = document.getElementById('selectAllForwardUsers');
                const selGroups = document.getElementById('selectAllForwardGroups');
                if (selUsers) {
                    selUsers.checked = false;
                    selUsers.onchange = function() {
                        userList.querySelectorAll('input.form-check-input').forEach(cb => { cb.checked = !!selUsers.checked; });
                    };
                }
                if (selGroups) {
                    selGroups.checked = false;
                    selGroups.onchange = function() {
                        const gl = document.getElementById('forward-groups-list');
                        if (!gl) return;
                        gl.querySelectorAll('input.form-check-input').forEach(cb => { cb.checked = !!selGroups.checked; });
                    };
                }
            })
            .catch(error => {
                console.error('Error loading groups:', error);
                const groupsList = document.getElementById('forward-groups-list');
                if (groupsList) {
                    groupsList.innerHTML = '<div class="text-danger small">Error loading groups</div>';
                }
            });
        
        // Rest of the function remains the same...
        const messagePreview = document.getElementById('forward-message-preview');
        if (messagePreview) {
            messagePreview.innerHTML = forwardMessageContent;
        }
        
        let media_url = null;
        let media_type = null;
        let fileName = null;
        
        if (messageElement.dataset.type === 'image') {
            const attachment = contentElement.querySelector('.message-attachment');
            if (attachment) {
                media_url = attachment.getAttribute('data-image-url');
                media_type = 'image';
                fileName = attachment.querySelector('.file-name')?.textContent;
            }
        } else if (messageElement.dataset.type === 'forward') {
            const attachment = contentElement.querySelector('.message-attachment');
            if (attachment) {
                media_url = attachment.getAttribute('data-image-url');
                media_type = 'image';
                fileName = attachment.querySelector('.file-name')?.textContent;
            }
        }
        
        const forwardBtn = document.getElementById('forward-btn');
        if (forwardBtn) {
            forwardBtn.onclick = () => {
                const selectedUsers = Array.from(userList.querySelectorAll('input.form-check-input:checked'))
                    .map(input => input.value);
                const groupsListNode = document.getElementById('forward-groups-list');
                const selectedGroups = groupsListNode ? Array.from(groupsListNode.querySelectorAll('input.form-check-input:checked')).map(input => input.value) : [];
                const allRecipients = [...selectedUsers, ...selectedGroups];
                if (allRecipients.length === 0) {
                    alert('Please select at least one recipient');
                    return;
                }
                
                // De-duplicate recipients and prevent forwarding to an invalid target
                const uniqueRecipients = Array.from(new Set(allRecipients));
                uniqueRecipients.forEach(recipient => {
                    const isGroup = recipient.startsWith('group_');
                    const recipientId = isGroup ? recipient.replace('group_', '') : recipient;
                    
                    if (isGroup) {
                        // Forward to group
                        socket.emit('send_group_message', {
                            sender_id: currentUser,
                            group_id: recipientId,
                            content: contentElement.textContent.trim(),
                            type: 'forward',
                            parent_message_id: messageId,
                            media_url: media_url,
                            media_type: media_type,
                            filename: fileName
                        });
                    } else {
                        // Forward to user
                        socket.emit('send_message', {
                            sender_id: currentUser,
                            receiver_id: recipientId,
                            content: contentElement.textContent.trim(),
                            type: 'forward',
                            parent_message_id: messageId,
                            media_url: media_url,
                            media_type: media_type,
                            filename: fileName
                        });
                    }
                });
                forwardModal.hide();
            };
        }
        
        forwardModal.show();
    };

    function sendReplyMessage(content, parentMessageId) {
        if (currentReceiver) {
            socket.emit('send_message', {
                sender_id: currentUser,
                receiver_id: currentReceiver,
                content: content,
                type: 'reply',
                parent_message_id: parentMessageId
            });
        }
    }

    // Add CSS for status colors
    const style = document.createElement('style');
    style.textContent = `
        .status-online { color: #31a24c !important; }
        .status-away { color: #f1c40f !important; }
        .status-offline { color: #95a5a6 !important; }
    `;
    document.head.appendChild(style);

    // Image preview click handler
    document.addEventListener('click', function(e) {
        const attachment = e.target.closest('.message-attachment');
        if (attachment) {
            e.preventDefault();
            const imageUrl = attachment.dataset.imageUrl;
            const index = imageGallery.indexOf(imageUrl);
            if (imageUrl) {
                openImagePreview(imageUrl, index);
            }
        }
    });

    // --- Fullscreen Viewer state ---
    const imageStage = document.querySelector('.image-stage');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const resetZoomBtn = document.getElementById('resetZoomBtn');

    let viewScale = 1;
    let viewTranslateX = 0;
    let viewTranslateY = 0;
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 5;
    const SCALE_STEP = 0.2;

    function applyTransform() {
        if (!modalImage) return;
        modalImage.style.transform = `translate(${viewTranslateX}px, ${viewTranslateY}px) scale(${viewScale})`;
        // update cursor
        if (imageStage) {
            imageStage.classList.toggle('cursor-zoom-in', viewScale <= 1);
            imageStage.classList.toggle('cursor-zoom-out', viewScale > 1);
        }
    }

    function resetTransform() {
        viewScale = 1;
        viewTranslateX = 0;
        viewTranslateY = 0;
        applyTransform();
    }

    function zoomAt(focusX, focusY, deltaScale) {
        const prevScale = viewScale;
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewScale * deltaScale));
        if (nextScale === prevScale) return;
        // keep the point under cursor stable: adjust translation
        const rect = modalImage.getBoundingClientRect();
        const imgCenterX = rect.left + rect.width / 2;
        const imgCenterY = rect.top + rect.height / 2;
        const offsetX = focusX - imgCenterX;
        const offsetY = focusY - imgCenterY;
        // New translation to keep offset proportional
        viewTranslateX += offsetX - offsetX * (nextScale / prevScale);
        viewTranslateY += offsetY - offsetY * (nextScale / prevScale);
        viewScale = nextScale;
        applyTransform();
    }

    window.openImagePreview = function(imageUrl, index) {
        if (!modalImage) return;

        // Reset transform per open
        resetTransform();

        modalImage.classList.add('loading');
        modalImage.src = '';
        modalImage.alt = 'Loading image...';

        const fullUrl = imageUrl.startsWith('/static/') ? imageUrl : `/static/${imageUrl.replace(/^\/*/, '')}`;

        if (imageUrl.includes('90fcee5b-e844-4edd-87f6-7e6db517f6f6_img21.png')) {
            showErrorState();
            return;
        }

        const img = new Image();

        img.onload = function() {
            modalImage.src = fullUrl;
            modalImage.classList.remove('loading');
            currentImageIndex = index;
            updateNavigationButtons();
            imageModal.show();
        };

        img.onerror = function() {
            showErrorState();
        };

        img.src = fullUrl;

        function showErrorState() {
            modalImage.src = '/static/images/error-image.png';
            modalImage.alt = 'Image not found';
            modalImage.classList.remove('loading');
            showToast("Image Missing", "This image is no longer available or has been deleted.", 'top-center');
            currentImageIndex = index;
            updateNavigationButtons();
            imageModal.show();
        }
    };        

    function updateNavigationButtons() {
        if (prevButton && nextButton) {
            prevButton.style.display = currentImageIndex > 0 ? 'block' : 'none';
            nextButton.style.display = currentImageIndex < imageGallery.length - 1 ? 'block' : 'none';
        }
    }

    if (prevButton && nextButton) {
        prevButton.addEventListener('click', () => {
            if (currentImageIndex > 0) {
                currentImageIndex--;
                resetTransform();
                modalImage.src = imageGallery[currentImageIndex];
                updateNavigationButtons();
            }
        });

        nextButton.addEventListener('click', () => {
            if (currentImageIndex < imageGallery.length - 1) {
                currentImageIndex++;
                resetTransform();
                modalImage.src = imageGallery[currentImageIndex];
                updateNavigationButtons();
            }
        });
    }

    window.removeImagePreview = removeImagePreview;

    // Zoom controls
    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1 + SCALE_STEP));
    }
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1 - SCALE_STEP));
    }
    if (resetZoomBtn) {
        resetZoomBtn.addEventListener('click', resetTransform);
    }

    // Wheel zoom (Ctrl or normal wheel to zoom; normal pan preserved via drag)
    if (imageStage) {
        imageStage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? (1 - SCALE_STEP) : (1 + SCALE_STEP);
            zoomAt(e.clientX, e.clientY, delta);
        }, { passive: false });
    }

    // Drag to pan
    if (imageStage) {
        let isDragging = false;
        let startX = 0, startY = 0;
        let originX = 0, originY = 0;
        imageStage.addEventListener('mousedown', (e) => {
            if (!modalImage) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            originX = viewTranslateX;
            originY = viewTranslateY;
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            viewTranslateX = originX + dx;
            viewTranslateY = originY + dy;
            applyTransform();
        });
        window.addEventListener('mouseup', () => { isDragging = false; });
    }

    // Pinch zoom (touch)
    if (imageStage) {
        let touchDistStart = 0;
        let touchCenter = { x: 0, y: 0 };
        function getTouchDist(t1, t2) {
            const dx = t2.clientX - t1.clientX;
            const dy = t2.clientY - t1.clientY;
            return Math.sqrt(dx*dx + dy*dy);
        }
        function getCenter(t1, t2) {
            return { x: (t1.clientX + t2.clientX)/2, y: (t1.clientY + t2.clientY)/2 };
        }
        imageStage.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                touchDistStart = getTouchDist(e.touches[0], e.touches[1]);
                touchCenter = getCenter(e.touches[0], e.touches[1]);
            }
        }, { passive: true });
        imageStage.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = getTouchDist(e.touches[0], e.touches[1]);
                const ratio = dist / (touchDistStart || dist);
                zoomAt(touchCenter.x, touchCenter.y, ratio);
                touchDistStart = dist; // incremental
            }
        }, { passive: false });
    }

    // Keyboard shortcuts inside modal
    document.getElementById('imagePreviewModal')?.addEventListener('keydown', (e) => {
        if (!document.getElementById('imagePreviewModal')?.classList.contains('show')) return;
        if (e.key === '+') { zoomAt(window.innerWidth/2, window.innerHeight/2, 1 + SCALE_STEP); }
        if (e.key === '-') { zoomAt(window.innerWidth/2, window.innerHeight/2, 1 - SCALE_STEP); }
        if (e.key === '0') { resetTransform(); }
        if (e.key === 'ArrowLeft') { prevButton?.click(); }
        if (e.key === 'ArrowRight') { nextButton?.click(); }
        if (e.key === 'Escape') { document.querySelector('#imagePreviewModal [data-bs-dismiss="modal"]')?.dispatchEvent(new Event('click')); }
    });

    // User search functionality
    const userSearchInput = document.getElementById('userSearch');
    if (userSearchInput) {
        userSearchInput.addEventListener('input', function () {
            const query = this.value.trim().toLowerCase();
            let found = false;
            document.querySelectorAll('#active-users-list .user-item').forEach(item => {
                const name = item.querySelector('.user-name-text')?.textContent.toLowerCase();
                const role = item.querySelector('.user-role')?.textContent.toLowerCase();
                if (name?.includes(query) || role?.includes(query)) {
                    item.style.display = '';
                    found = true;
                } else {
                    item.style.display = 'none';
                }
            });
            
            let noUsersMsg = document.getElementById('noUsersFound');
            if (!found) {
                if (!noUsersMsg) {
                    noUsersMsg = document.createElement('li');
                    noUsersMsg.id = 'noUsersFound';
                    noUsersMsg.className = 'list-group-item text-center text-muted';
                    noUsersMsg.textContent = 'No users found';
                    const activeUsersList = document.getElementById('active-users-list');
                    if (activeUsersList) activeUsersList.appendChild(noUsersMsg);
                }
            } else if (noUsersMsg) {
                noUsersMsg.remove();
            }
        });
    }

    // Refresh users button
    const refreshUsersBtn = document.getElementById('refreshUsers');
    if (refreshUsersBtn) {
        refreshUsersBtn.addEventListener('click', function () {
            refreshUsersBtn.disabled = true;
            refreshUsersBtn.classList.add('loading');
            loadOnlineUsers();
            setTimeout(() => {
                refreshUsersBtn.disabled = false;
                refreshUsersBtn.classList.remove('loading');
            }, 800);
        });
    }

    // Clear chat button
    const clearChatBtn = document.getElementById('clearChat');
    if (clearChatBtn) {
        clearChatBtn.addEventListener('click', function () {
            if (currentReceiver && confirm('Are you sure you want to clear this chat? This will only clear your view.')) {
                if (messagesContainer) messagesContainer.innerHTML = '';
            }
        });
    }

    // Scroll to bottom functionality
    const scrollToBottomBtn = document.getElementById('scrollToBottom');
    const scrollBottomBtn = document.getElementById('scrollBottom');
    
    function scrollMessagesToBottom() {
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }
    
    if (scrollToBottomBtn) {
        scrollToBottomBtn.addEventListener('click', scrollMessagesToBottom);
    }
    
    if (scrollBottomBtn) {
        scrollBottomBtn.addEventListener('click', scrollMessagesToBottom);
    }
    
    if (messagesContainer) {
        messagesContainer.addEventListener('scroll', function () {
            if (scrollBottomBtn) {
                if (messagesContainer.scrollHeight - messagesContainer.scrollTop > messagesContainer.clientHeight + 100) {
                    scrollBottomBtn.style.display = 'block';
                } else {
                    scrollBottomBtn.style.display = 'none';
                }
            }
        });
    }

    // Recipient search in forward modal
    const recipientSearchInput = document.getElementById('recipientSearch');
    if (recipientSearchInput) {
        recipientSearchInput.addEventListener('input', function () {
            const query = this.value.trim().toLowerCase();
            // Filter users
            let usersFound = false;
            const forwardUsersList = document.getElementById('forward-users-list');
            (forwardUsersList ? forwardUsersList.querySelectorAll('.form-check') : []).forEach(item => {
                const label = item.querySelector('.form-check-label')?.textContent.toLowerCase();
                if (label && label.includes(query)) {
                    item.style.display = '';
                    usersFound = true;
                } else {
                    item.style.display = 'none';
                }
            });

            // Filter groups
            let groupsFound = false;
            const forwardGroupsList = document.getElementById('forward-groups-list');
            (forwardGroupsList ? forwardGroupsList.querySelectorAll('.form-check') : []).forEach(item => {
                const label = item.querySelector('.form-check-label')?.textContent.toLowerCase();
                if (label && label.includes(query)) {
                    item.style.display = '';
                    groupsFound = true;
                } else {
                    item.style.display = 'none';
                }
            });

            // Users empty state
            let noUsersMsg = document.getElementById('noRecipientsFoundUsers');
            if (!usersFound) {
                if (!noUsersMsg) {
                    noUsersMsg = document.createElement('div');
                    noUsersMsg.id = 'noRecipientsFoundUsers';
                    noUsersMsg.className = 'text-center text-muted my-2';
                    noUsersMsg.textContent = 'No recipients found';
                    if (forwardUsersList) forwardUsersList.appendChild(noUsersMsg);
                }
            } else if (noUsersMsg) {
                noUsersMsg.remove();
            }

            // Groups empty state
            let noGroupsMsg = document.getElementById('noRecipientsFoundGroups');
            if (!groupsFound) {
                if (!noGroupsMsg) {
                    noGroupsMsg = document.createElement('div');
                    noGroupsMsg.id = 'noRecipientsFoundGroups';
                    noGroupsMsg.className = 'text-center text-muted my-2';
                    noGroupsMsg.textContent = 'No groups found';
                    if (forwardGroupsList) forwardGroupsList.appendChild(noGroupsMsg);
                }
            } else if (noGroupsMsg) {
                noGroupsMsg.remove();
            }
        });
    }

    // Keyboard shortcut hint modal
    let shortcutsModal = null;

    document.addEventListener('DOMContentLoaded', () => {
        // Initialize modal once
        shortcutsModal = new bootstrap.Modal(document.getElementById('shortcutsModal'));
        
        // Handle modal show/hide events properly
        document.getElementById('shortcutsModal')?.addEventListener('hidden.bs.modal', () => {
            document.querySelector('.modal-backdrop')?.remove();
        });

        // Better click handler for shortcut icon
        document.querySelectorAll('.shortcut-icon').forEach(el => {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                if (shortcutsModal) {
                    shortcutsModal.show();
                }
            });
        });

        // Add ESC key handler to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && shortcutsModal) {
                shortcutsModal.hide();
            }
        });
    });

    // Make sure to clean up when leaving the page
    window.addEventListener('beforeunload', () => {
        if (shortcutsModal) {
            shortcutsModal.hide();
        }
    });

    // Active user highlight
    function updateActiveUserHighlight() {
        document.querySelectorAll('.user-item').forEach(item => {
            const nameText = item.querySelector('.user-name-text');
            if (nameText) {
                if (item.dataset.userId === currentReceiver) {
                    item.classList.add('active');
                    nameText.classList.add('active-user-name');
                } else {
                    item.classList.remove('active');
                    nameText.classList.remove('active-user-name');
                }
            }
        });
    }
    
    function updateUnreadCountUI(element, count) {
        let countElement = element.querySelector('.unread-count');
        
        if (!countElement) {
            countElement = document.createElement('span');
            countElement.className = 'unread-count badge bg-danger ms-2 hide';
            const nameElement = element.querySelector('.user-name-text, .group-name-text');
            if (nameElement) {
                nameElement.parentNode.appendChild(countElement);
            }
        }
        
        if (count > 0) {
            countElement.textContent = count;
            countElement.classList.remove('hide');
            countElement.style.display = 'inline-block';
        } else {
            countElement.classList.add('hide');
            countElement.textContent = '';
            countElement.style.display = 'none';
        }
    }

    // Add periodic reordering instead of immediate reordering on every event
    let reorderDebounceTimer = null;

    function scheduleReorder() { /* sorting removed */ }

    function updateLastActivityForUser(userId, timestamp) { /* sorting removed */ }
    
    function updateLastActivityForGroup(groupId, timestamp) { /* sorting removed */ }   

    function reattachUserItemListeners() {
        const userItems = document.querySelectorAll('.user-item');
        userItems.forEach(item => {
            const userId = item.dataset.userId;
            
            // Remove existing click listeners to avoid duplicates
            const newItem = item.cloneNode(true);
            item.parentNode.replaceChild(newItem, item);
            
            // Reattach click listener
            newItem.addEventListener('click', () => {
                switchToUser(userId);
            });
            
            // Reattach keyboard events
            newItem.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    switchToUser(userId);
                }
            });
            
            // Ensure proper tabindex and role for accessibility
            newItem.setAttribute('tabindex', '0');
            newItem.setAttribute('role', 'listitem');
        });
    }

    function formatLastActivityTime(timestamp) {
        if (!timestamp) return '';
        
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        
        if (diffSecs < 10) return 'Just now';
        if (diffSecs < 60) return `${diffSecs}s ago`;
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        
        return date.toLocaleDateString([], {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    function reorderUsersByPolicy() { /* sorting removed */ }
    
    function sortGroupListByPolicy() { /* deprecated */ }

    // Resort helpers
    let resortUserListTimer = null;
    function scheduleResortUserList() {
        if (resortUserListTimer) {
            clearTimeout(resortUserListTimer);
        }
        resortUserListTimer = setTimeout(() => {
            resortUserListTimer = null;
            resortUserList();
        }, 50); // small debounce to avoid thrashing
    }

    // Unread counts are displayed but DO NOT affect sorting order.

    function resortUserList() {
        const list = document.getElementById('active-users-list');
        if (!list || !document.body.contains(list)) return;
        const items = Array.from(list.querySelectorAll('.user-item'));
        if (items.length === 0) return;

        const activeUserId = document.querySelector('.user-item.active')?.dataset.userId;
        items.sort((a, b) => {
            const aId = a.dataset.userId;
            const bId = b.dataset.userId;
            const aPinned = pinnedUsers.has(String(aId));
            const bPinned = pinnedUsers.has(String(bId));
            if (aPinned !== bPinned) return aPinned ? -1 : 1; // 1) pinned first

            const aTs = Number(userLastDirectTs.get(aId) || 0);
            const bTs = Number(userLastDirectTs.get(bId) || 0);
            if (aTs !== bTs) return bTs - aTs; // 2) latest activity

            const aName = (a.querySelector('.user-name-text')?.textContent || '').toLowerCase();
            const bName = (b.querySelector('.user-name-text')?.textContent || '').toLowerCase();
            return aName.localeCompare(bName); // 3) A–Z
        });
        const frag = document.createDocumentFragment();
        items.forEach(item => {
            if (item.dataset.userId === activeUserId) item.classList.add('active');
            frag.appendChild(item);
        });
        list.appendChild(frag);
        reattachUserItemListeners();
    }

    function resortGroupList() {
        const list = document.getElementById('group-list');
        if (!list) return;
        const items = Array.from(list.querySelectorAll('.group-item'));
        if (items.length === 0) return;

        items.sort((a, b) => {
            const aId = String(a.dataset.groupId);
            const bId = String(b.dataset.groupId);
            const aPinned = pinnedGroups.has(aId);
            const bPinned = pinnedGroups.has(bId);
            if (aPinned !== bPinned) return aPinned ? -1 : 1; // 1) pinned first

            const aTs = groupLastActivityTs.get(aId) || 0;
            const bTs = groupLastActivityTs.get(bId) || 0;
            if (aTs !== bTs) return bTs - aTs; // 2) latest activity

            const aName = (a.querySelector('.group-name-text')?.textContent || '').toLowerCase();
            const bName = (b.querySelector('.group-name-text')?.textContent || '').toLowerCase();
            return aName.localeCompare(bName); // 3) A–Z
        });
        const frag = document.createDocumentFragment();
        items.forEach(item => frag.appendChild(item));
        list.appendChild(frag);
    }

    // --- Pin buttons: apply badges and toggle ---
    function applyPinBadgesToLists() {
        document.querySelectorAll('#active-users-list .user-item').forEach(li => {
            const uid = String(li.dataset.userId);
            applyPinBadgeToUser(uid, pinnedUsers.has(uid));
        });
        document.querySelectorAll('#group-list .group-item').forEach(li => {
            const gid = String(li.dataset.groupId);
            applyPinBadgeToGroup(gid, pinnedGroups.has(gid));
        });
    }

    function ensurePinButton(container, type, id) {
        let btn = container.querySelector('.btn-pin-chat');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-pin-chat';
            btn.setAttribute('data-pin-target-type', type);
            btn.setAttribute('data-pin-target-id', id);
            btn.title = 'Pin chat';
            btn.setAttribute('aria-label', 'Pin chat');
            btn.innerHTML = '<i class="fas fa-thumbtack"></i>';
            container.appendChild(btn);
        } else {
            btn.setAttribute('data-pin-target-type', type);
            btn.setAttribute('data-pin-target-id', id);
        }
        return btn;
    }

    function applyPinBadgeToUser(userId, isPinned) {
        const li = document.querySelector(`#active-users-list .user-item[data-user-id="${CSS.escape(userId)}"]`);
        if (!li) return;
        const metaRow = li.querySelector('.d-flex.justify-content-between.align-items-center');
        if (metaRow) ensurePinButton(metaRow, 'user', userId).classList.toggle('pinned', !!isPinned);
    }

    function applyPinBadgeToGroup(groupId, isPinned) {
        const li = document.querySelector(`#group-list .group-item[data-group-id="${CSS.escape(String(groupId))}"]`);
        if (!li) return;
        let btn = li.querySelector('.btn-pin-chat');
        if (!btn) {
            const actions = li.querySelector('.group-item-actions') || li;
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-pin-chat';
            btn.setAttribute('data-pin-target-type', 'group');
            btn.setAttribute('data-pin-target-id', String(groupId));
            btn.title = 'Pin chat';
            btn.setAttribute('aria-label', 'Pin chat');
            btn.innerHTML = '<i class="fas fa-thumbtack"></i>';
            actions.appendChild(btn);
        }
        btn.classList.toggle('pinned', !!isPinned);
    }

    document.addEventListener('click', (e) => {
        const pinBtn = e.target.closest('.btn-pin-chat');
        if (!pinBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const type = pinBtn.getAttribute('data-pin-target-type');
        const id = pinBtn.getAttribute('data-pin-target-id');
        const willPin = !pinBtn.classList.contains('pinned');
        fetch('/chat_pins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ target_type: type, target_id: id, pin: willPin })
        }).then(r => r.json()).then(res => {
            if (!res || res.error) return;
            if (type === 'user') {
                if (willPin) pinnedUsers.add(String(id)); else pinnedUsers.delete(String(id));
                applyPinBadgeToUser(String(id), willPin);
                resortUserList();
            } else {
                const gid = String(id);
                if (willPin) pinnedGroups.add(gid); else pinnedGroups.delete(gid);
                applyPinBadgeToGroup(gid, willPin);
                resortGroupList();
            }
        }).catch(() => {});
    });
    
    // Helper function to convert timestamp to numeric value
    function getTimestampValue(timestamp) {
        if (!timestamp) return 0;
        
        // If it's already a numeric timestamp
        if (!isNaN(timestamp)) {
            return parseInt(timestamp, 10);
        }
        
        // If it's a date string, convert to timestamp
        try {
            return new Date(timestamp).getTime();
        } catch (e) {
            return 0;
        }
    }

    function updateAllUnreadCounts() {
        // Update direct message counts
        document.querySelectorAll('.user-item').forEach(item => {
            const userId = item.dataset.userId;
            const count = unreadCounts[userId] || 0;
            updateUnreadCountUI(item, count);
        });
        
        // Update group message counts
        document.querySelectorAll('.group-item').forEach(item => {
            const groupId = item.dataset.groupId;
            const count = unreadCounts[`group_${groupId}`] || 0;
            updateUnreadCountUI(item, count);
        });
        
    }

    function updateUserStatus(userId, isOnline) {
        const userItem = document.querySelector(`.user-item[data-user-id="${userId}"]`);
        if (!userItem) return;
        
        // Update the data attribute
        userItem.dataset.isOnline = String(isOnline);
        
        // Update the visual indicator
        const statusElement = userItem.querySelector('.user-status');
        if (statusElement) {
            statusElement.classList.remove('online', 'offline');
            statusElement.classList.add(isOnline ? 'online' : 'offline');
            statusElement.setAttribute('aria-label', isOnline ? 'Online' : 'Offline');
        }

    }

    // --- GROUP CHAT SUPPORT ---
    const createGroupBtn = document.getElementById('createGroupBtn');
    const createGroupModal = new bootstrap.Modal(document.getElementById('createGroupModal'));
    const createGroupForm = document.getElementById('createGroupForm');
    const groupNameInput = document.getElementById('groupName');
    const groupMembersSelect = document.getElementById('groupMembersSelect');
    const manageGroupBtn = document.getElementById('manageGroupBtn');
    const manageGroupModal = new bootstrap.Modal(document.getElementById('manageGroupModal'));
    const manageGroupMembersList = document.getElementById('manageGroupMembersList');
    const addGroupMemberSelect = document.getElementById('addGroupMemberSelect');
    const addGroupMemberBtn = document.getElementById('addGroupMemberBtn');
    const seenListModal = new bootstrap.Modal(document.getElementById('seenListModal'));
    const seenUsersList = document.getElementById('seenUsersList');

    function loadGroups() {
        if (!currentUser) return;
        fetch(`/groups`)
            .then(res => res.json())
            .then(groups => {
                groupList = groups;
                renderGroupList();
                
                // Seed group last activity from API data if present
                groups.forEach(group => {
                    if (group.last_activity) {
                        const t = Date.parse(group.last_activity);
                        if (!isNaN(t)) groupLastActivityTs.set(String(group.id), t);
                    }
                });
                // Initial resort for groups
                resortGroupList();
            });
    }

    function renderGroupList() {
                if (!groupListUI) return;
        groupListUI.innerHTML = '';
        
        groupList.forEach(group => {
            const li = document.createElement('li');
            li.className = 'list-group-item group-item';
            li.dataset.groupId = group.id;
            if (currentGroup === group.id) {
                li.classList.add('active');
            }

            const unreadCount = unreadCounts[`group_${group.id}`] || 0;
            const badgeHtml = unreadCount > 0 ?
                `<span class="unread-count badge bg-danger ms-2">${unreadCount}</span>` :
                '<span class="unread-count badge bg-danger ms-2 hide" style="display: none;">0</span>';

            const groupName = group.name || `Group ${group.id}`;
            const safeGroupName = escapeHtml(groupName);
            const lastActivity = group.last_activity ? formatLastActivityTime(group.last_activity) : '';
            const safeLastActivity = lastActivity ? escapeHtml(lastActivity) : '';

            li.innerHTML = `
                <i class="fas fa-users me-2"></i>
                <div class="group-info flex-grow-1">
                    <div class="group-name d-flex align-items-center">
                        <span class="group-name-text">${safeGroupName}</span>
                        ${badgeHtml}
                    </div>
                    <small class="last-activity-time text-muted" style="font-size: 0.75rem;">
                        ${safeLastActivity}
                    </small>
                </div>
                <div class="group-item-actions" role="group" aria-label="Group actions">
                    <button type="button" class="btn btn-group-info" data-group-id="${group.id}" title="View members" aria-label="View members">
                        <i class="fas fa-circle-info"></i>
                    </button>
                </div>
            `;

            li.addEventListener('click', () => {
                switchToGroup(group.id, group.name, group.creator_id);
            });

            const infoBtn = li.querySelector('.btn-group-info');
            if (infoBtn) {
                infoBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openGroupMembersInfo(group.id);
                });
            }

            groupListUI.appendChild(li);
            applyPinBadgeToGroup(String(group.id), pinnedGroups.has(String(group.id)));
        });
        
        // Sorting removed
    }

    function openGroupMembersInfo(groupId) {
        if (!groupMembersModal || !groupMembersListContainer) return;
        const numericId = Number(groupId);
        const resolvedId = Number.isNaN(numericId) ? groupId : numericId;
        const group = groupList.find(g => g.id === resolvedId);

        if (groupMembersModalTitle) {
            groupMembersModalTitle.textContent = group ? `${group.name} · Members` : 'Group Members';
        }
        if (groupMembersMeta) {
            groupMembersMeta.innerHTML = '<span><i class="fas fa-spinner fa-spin me-2"></i>Loading members...</span>';
        }
        groupMembersListContainer.innerHTML = `
            <li class="list-group-item text-center py-3">
                <div class="spinner-border text-primary" role="status" aria-hidden="true"></div>
            </li>
        `;

        groupMembersModal.show();

        fetch(`/groups/${resolvedId}/members`)
            .then(res => {
                if (!res.ok) throw new Error(res.statusText || 'Failed to load members');
                return res.json();
            })
            .then(members => {
                renderGroupMembersInfo(resolvedId, Array.isArray(members) ? members : []);
            })
            .catch(err => {
                if (groupMembersMeta) {
                    groupMembersMeta.innerHTML = '<span class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>Unable to load members.</span>';
                }
                groupMembersListContainer.innerHTML = `
                    <li class="list-group-item text-center text-muted py-3">Failed to load group members.</li>
                `;
                try { showToast('Error', err.message || 'Failed to load group members'); } catch (_) {}
            });
    }

    function renderGroupMembersInfo(groupId, members) {
        if (!groupMembersListContainer) return;
        const group = groupList.find(g => g.id === groupId);
        if (groupMembersModalTitle && group) {
            groupMembersModalTitle.textContent = `${group.name} · Members`;
        }

        if (!Array.isArray(members) || members.length === 0) {
            groupMembersListContainer.innerHTML = `
                <li class="list-group-item text-center text-muted py-3">
                    No members found for this group.
                </li>
            `;
            if (groupMembersMeta) {
                groupMembersMeta.textContent = 'Invite colleagues to collaborate in this group.';
            }
            return;
        }

        const totalMembers = members.length;
        const adminCount = members.reduce((count, member) => count + (member.is_admin ? 1 : 0), 0);
        if (groupMembersMeta) {
            const summaryParts = [`${totalMembers} member${totalMembers === 1 ? '' : 's'}`];
            if (adminCount) summaryParts.push(`${adminCount} admin${adminCount === 1 ? '' : 's'}`);
            groupMembersMeta.innerHTML = `<i class="fas fa-users me-2"></i>${summaryParts.join(' • ')}`;
        }

        groupMembersListContainer.innerHTML = members
            .map(member => renderGroupMemberItem(member))
            .join('');
    }

    function renderGroupMemberItem(member) {
        const name = member?.name || member?.user_id || 'Member';
        const safeName = escapeHtml(name);
        const roleText = member?.role || 'Member';
        const safeRole = escapeHtml(roleText);
        const isAdmin = !!member?.is_admin;
        const isYou = currentUser && member?.user_id && String(member.user_id) === String(currentUser);
        const initials = escapeHtml(getMemberInitials(name, member?.user_id));

        const badges = [];
        if (isYou) {
            badges.push('<span class="badge bg-secondary ms-2">You</span>');
        }
        if (isAdmin) {
            badges.push('<span class="badge bg-primary ms-2">Admin</span>');
        }
        const badgeHtml = badges.join('');

        return `
            <li class="list-group-item d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center">
                    <div class="member-avatar me-3" aria-hidden="true">${initials}</div>
                    <div class="member-details">
                        <div class="fw-semibold">${safeName}</div>
                        <div class="text-muted small">${safeRole}</div>
                    </div>
                </div>
                <div class="text-end">
                    ${badgeHtml}
                </div>
            </li>
        `;
    }

    function getMemberInitials(name, fallback) {
        const source = (name || '').trim();
        if (!source) {
            return formatFallbackInitials(fallback);
        }
        const parts = source.split(/\s+/);
        const first = parts[0] ? parts[0][0] : '';
        const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
        const combined = (first + last).toUpperCase();
        if (combined) return combined;
        return formatFallbackInitials(fallback);
    }

    function formatFallbackInitials(fallback) {
        if (!fallback) return '?';
        const raw = String(fallback).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!raw) return '?';
        if (raw.length === 1) return raw;
        return raw.slice(0, 2);
    }

    function switchToGroup(groupId, groupName, creatorId) {
        // Remove active class from all groups and users
        document.querySelectorAll('.group-item, .user-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Add active class to selected group
        const selectedGroup = document.querySelector(`.group-item[data-group-id="${groupId}"]`);
        if (selectedGroup) {
            selectedGroup.classList.add('active');
        }
        
        currentGroup = groupId;
        currentReceiver = null;
        if (chatWithHeading) chatWithHeading.textContent = groupName;
        
        if (chatHeader) chatHeader.style.display = 'block';
        if (chatFooter) chatFooter.style.display = 'block';
        
        hideWelcomeCard();

        // Ensure presence status is hidden for group chat
        hideChatStatus();
        
        if (messageInput) messageInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        
        if (manageGroupBtn) {
            fetch(`/groups/${groupId}/members`).then(res => res.json()).then(members => {
                groupMembers = members;
                isGroupAdmin = members.some(m => m.user_id === currentUser && m.is_admin);
                manageGroupBtn.classList.toggle('d-none', !isGroupAdmin);
            });
        }
        
        if (socket) socket.emit('join_group', { group_id: groupId });
        loadGroupMessages(groupId);

        // Proactively clear unread badge for this group in UI
        unreadCounts[`group_${groupId}`] = 0;
        updateAllUnreadCounts();

        // Ensure the left-side toggle shows Group Chat as active for clarity
        try { showGroupChat(); } catch (_) {}
    }

    function loadGroupMessages(groupId) {
        if (!messagesContainer) return;
        const reqId = ++groupMessagesRequestId;
        messagesContainer.innerHTML = '';
        fetchJSON(`/groups/${groupId}/messages`)
            .then(messages => {
                if (reqId !== groupMessagesRequestId) return; // Ignore outdated response
                if (!Array.isArray(messages)) return;
                messagesContainer.innerHTML = '';
                messages.reverse().forEach(message => {
                    if (message.sender_id !== currentUser) {
                        socket.emit('mark_group_message_seen', {
                            message_id: message.id,
                            user_id: currentUser,
                            group_id: groupId
                        });
                    }
                    appendGroupMessage(message);
                });
            })
            .catch(err => {
                try { showToast('Error', err.message || 'Failed to load group messages'); } catch (_) {}
            });
    }

    function appendGroupMessage(message) {
        if (!messagesContainer) return;

        // Final safety check - prevent duplicates in case of any edge cases
        const existingMessage = document.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMessage) {
            console.warn('Duplicate message prevented - already exists in DOM:', message.id);
            return;
        }
        
        const messageElement = document.createElement('div');
        messageElement.className = `message ${message.sender_id === currentUser ? 'sent' : 'received'}`;
        messageElement.dataset.messageId = message.id;
        messageElement.dataset.timestamp = message.timestamp || message.created_at;
        messageElement.dataset.type = message.type || message.message_type;
        if (message.parent_message_id) {
            messageElement.dataset.parentMessageId = message.parent_message_id;
        }
    
        // For group messages, we don't use is_read - we check if current user has seen it
        // This should come from the server response (message.seen_by_current_user)
        if (message.sender_id === currentUser || message.seen_by_current_user) {
            messageElement.classList.add('seen');
        }
        
        let contentHtml = '';
        const messageType = message.type || message.message_type;

        // Sender label for received group messages
        const showSenderLabel = message.sender_id !== currentUser;
        const senderDisplayName = message.sender_name || message.sender_id || 'Unknown';
        const sanitizedSenderName = escapeHtml(senderDisplayName);
        const senderLabelHtml = showSenderLabel
            ? `<div class="sender-line text-primary fw-semibold small mb-1" aria-label="Message from ${sanitizedSenderName}"><i class="fas fa-user-circle me-1" aria-hidden="true"></i>${sanitizedSenderName}</div>`
            : '';
        
        if (messageType === 'reply') {
            contentHtml += createReplyContent(message);
        }
        
        if (messageType === 'forward') {
            contentHtml += `<div class="forwarded">${createMessageHeader(message)}</div>`;
            if (message.media_url && (message.media_type === 'image' || (message.media_url.match(/\.(jpg|jpeg|png)$/i)))) {
                let fullImageUrl = message.media_url;
                if (!fullImageUrl.startsWith('/static/')) {
                    fullImageUrl = `/static/${fullImageUrl.replace(/^\/*/, '')}`;
                }
                if (!imageGallery.includes(fullImageUrl)) imageGallery.push(fullImageUrl);
                let fileName = message.filename || 'Attachment';
                contentHtml += `<div class="image-message-block">
                    <div class="message-attachment" data-image-url="${fullImageUrl}">
                        <i class="fas fa-paperclip"></i>
                        <span class="file-name">${fileName}</span>
                    </div>
                </div>`;
            } else {
                if (message.media_url && message.media_type === 'file') {
                    const fileName = message.filename || 'Attachment';
                    contentHtml += `<div class="file-attachment">
                        <div class="file-thumb">
                            <i class="${getFileIconClass(fileName)}"></i>
                        </div>
                        <div class="file-meta">
                            <div class="file-name" title="${fileName}">${fileName}</div>
                            ${message.file_size ? `<div class=\"file-size\">${formatBytes(message.file_size)}</div>` : ''}
                            <div class="file-actions">
                                <a href="/download/${message.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                                <a href="/download/${message.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                            </div>
                        </div>
                    </div>`;
                } else {
                    contentHtml += `<p>${message.content}</p>`;
                }
            }
        } else if (messageType === 'image' && message.media_url) {
            const fullImageUrl = message.media_url.startsWith('/static/') ? message.media_url : `/static/${message.media_url}`;
            if (!imageGallery.includes(fullImageUrl)) imageGallery.push(fullImageUrl);
            const hasText = message.content && message.content.trim() && message.content !== message.media_url;
            let fileName = message.filename || 'Attachment';
            contentHtml += `<div class="image-message-block">`;
            if (hasText) {
                contentHtml += `<div class="image-message-text">${message.content}</div>`;
            }
            contentHtml += `
                <div class="message-attachment" data-image-url="${fullImageUrl}">
                    <i class="fas fa-paperclip"></i>
                    <span class="file-name">${fileName}</span>
                </div>
            </div>`;
        } else if (messageType === 'file' && message.media_url) {
            const fullFileUrl = message.media_url.startsWith('/static/') ? message.media_url : `/static/${message.media_url}`;
            const fileName = message.filename || 'Attachment';
            contentHtml += `<div class="file-attachment">
                <div class="file-thumb">
                    <i class="${getFileIconClass(fileName)}"></i>
                </div>
                <div class="file-meta">
                    <div class="file-name" title="${fileName}">${fileName}</div>
                    ${message.file_size ? `<div class="file-size">${formatBytes(message.file_size)}</div>` : ''}
                    <div class="file-actions">
                        <a href="/download/${message.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                        <a href="/download/${message.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                    </div>
                </div>
            </div>`;
            if (message.content && message.content.trim() && message.content !== message.media_url) {
                contentHtml += `<p>${message.content}</p>`;
            }
        } else {
            contentHtml += `<p>${message.content}</p>`;
        }
        
        const timestamp = message.timestamp || message.created_at;
        const formattedTime = formatMessageTime(timestamp);
        
        // Seen status eye icon will be rendered in metadata (after time) to match direct chat ticks UI
        
        let pinnedLabel = message.pinned ? `<span class="pinned-label badge bg-warning text-dark ms-2" title="Pinned"><i class="fas fa-thumbtack"></i> Pinned</span>` : '';
    
        messageElement.innerHTML = `
            <div class="content">
                ${senderLabelHtml}${contentHtml}
                <div class="message-actions">
                    <button onclick="handleReply(${message.id})" class="btn btn-sm" title="Reply to this message">
                        <i class="fas fa-reply"></i>
                    </button>
                    <button onclick="handleForward(${message.id})" class="btn btn-sm" title="Forward this message">
                        <i class="fas fa-share"></i>
                    </button>
                    <button onclick="handlePin('${message.id}')" class="btn btn-sm pin-btn${message.pinned ? ' pinned' : ''}" title="${message.pinned ? 'Unpin this message' : 'Pin this message'}">
                        <i class="fas fa-thumbtack${message.pinned ? ' text-warning' : ''}"></i>
                    </button>
                </div>
                <span class="sender-name d-none">${sanitizedSenderName}</span>
            </div>
            <div class="metadata">
                <span class="time" title="${new Date(timestamp).toLocaleString()}">${formattedTime}</span><span class="seen-status-eye" data-message-id="${message.id}"><i class="fas fa-eye"></i></span>
                ${pinnedLabel}
            </div>
        `;
        
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
                    if (message.sender_id !== currentUser) {
                        socket.emit('mark_group_message_seen', {
                            message_id: message.id,
                            group_id: message.group_id
                        });
                    }
    
        if (message.pinned) {
            updatePinUI(message.id, true);
        }
    }

    // Seen status eye icon click
    if (messagesContainer) {
        messagesContainer.addEventListener('click', function(e) {
            const eye = e.target.closest('.seen-status-eye');
            if (eye) {
                const messageId = eye.dataset.messageId;
                fetch(`/messages/${messageId}/seen`).then(res => res.json()).then(users => {
                    if (!seenUsersList) return;
                    if (!Array.isArray(users) || users.length === 0) {
                        seenUsersList.innerHTML = `<div class="seen-empty-state"><i class='fas fa-eye me-2'></i>No viewers yet</div>`;
                        seenListModal.show();
                        return;
                    }

                    const markup = users.map(u => {
                        const name = (u.name || u.user_id || 'Unknown').toString();
                        const seenTime = u.seen_at ? formatSeenTime(u.seen_at) : '';
                        const initials = name.trim().split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
                        return `
                            <div class="seen-user-card">
                                <div class="seen-user-left">
                                    <div class="seen-avatar" aria-hidden="true">${initials}</div>
                                    <div class="seen-name" title="${name}">${name}</div>
                                </div>
                                <div class="seen-at" aria-label="Seen at">${seenTime}</div>
                            </div>`;
                    }).join('');
                    seenUsersList.innerHTML = markup;
                    seenListModal.show();
                }).catch(() => {
                    if (seenUsersList) {
                        seenUsersList.innerHTML = `<div class="seen-empty-state">Failed to load viewers</div>`;
                        seenListModal.show();
                    }
                });
            }
        });
    }

    // Create group modal logic
    if (createGroupBtn) {
        createGroupBtn.addEventListener('click', () => {
            if (!groupMembersSelect) return;
            
            groupMembersSelect.innerHTML = '';
            document.querySelectorAll('.user-item').forEach(item => {
                const userId = item.dataset.userId;
                if (userId !== currentUser) {
                    const name = item.querySelector('.user-name-text')?.textContent;
                    groupMembersSelect.innerHTML += `<div class='form-check'><input class='form-check-input' type='checkbox' value='${userId}' id='group-member-${userId}'><label class='form-check-label' for='group-member-${userId}'>${name}</label></div>`;
                }
            });
            // Reset group name validation state each time modal opens
            const groupNameInputEl = document.getElementById('groupName');
            const feedbackEl = document.getElementById('groupNameFeedback');
            if (groupNameInputEl) {
                groupNameInputEl.classList.remove('is-invalid');
                if (feedbackEl) { feedbackEl.style.display = ''; feedbackEl.textContent = 'Group name already exists'; }
            }

            // Wire Select All for Create Group modal
            const selectAllCreate = document.getElementById('selectAllCreateMembers');
            if (selectAllCreate) {
                // Ensure unchecked by default
                selectAllCreate.checked = false;
                selectAllCreate.onchange = function() {
                    const checks = groupMembersSelect.querySelectorAll('.form-check-input');
                    checks.forEach(cb => { cb.checked = !!selectAllCreate.checked; });
                };
            }
            if (groupNameInput) groupNameInput.value = '';
            createGroupModal.show();
            initGroupMemberSearch();
        });
    }

    // Group member search functionality
    function initGroupMemberSearch() {
        const groupMemberSearch = document.getElementById('groupMemberSearch');
        if (!groupMemberSearch) return;
        
        groupMemberSearch.addEventListener('input', function() {
            const query = this.value.toLowerCase().trim();
            const memberCheckboxes = document.querySelectorAll('#groupMembersSelect .form-check');
            
            memberCheckboxes.forEach(checkbox => {
                const label = checkbox.querySelector('.form-check-label');
                if (label) {
                    const text = label.textContent.toLowerCase();
                    if (text.includes(query)) {
                        checkbox.style.display = 'block';
                    } else {
                        checkbox.style.display = 'none';
                    }
                }
            });
        });
    }

    // Create group form submission
    if (createGroupForm) {
        createGroupForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const name = groupNameInput?.value.trim();
            const memberIds = Array.from(groupMembersSelect?.querySelectorAll('input:checked') || []).map(i => i.value);
            
            fetch('/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, creator_id: currentUser, member_ids: memberIds })
            }).then(async res => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    // Handle duplicate name or other validation errors
                    const groupNameInputEl = document.getElementById('groupName');
                    const feedbackEl = document.getElementById('groupNameFeedback');
                    if (data && data.error) {
                        if (groupNameInputEl) groupNameInputEl.classList.add('is-invalid');
                        if (feedbackEl) { feedbackEl.textContent = data.error; feedbackEl.style.display = 'block'; }
                        return;
                    }
                    if (groupNameInputEl) groupNameInputEl.classList.add('is-invalid');
                    if (feedbackEl) { feedbackEl.textContent = 'Failed to create group'; feedbackEl.style.display = 'block'; }
                    return;
                }
                if (data.group_id) {
                    createGroupModal.hide();
                    setTimeout(() => {
                        const newGroup = groupList.find(g => g.id == data.group_id);
                        if (newGroup) {
                            switchToGroup(newGroup.id, newGroup.name, newGroup.creator_id);
                        } else {
                            loadGroups();
                            setTimeout(() => {
                                const ng = groupList.find(g => g.id == data.group_id);
                                if (ng) switchToGroup(ng.id, ng.name, ng.creator_id);
                            }, 300);
                        }
                    }, 300);
                }
            });
        });
    }

    // Update the manageGroupBtn click handler to include search initialization
    if (manageGroupBtn) {
        manageGroupBtn.addEventListener('click', () => {
            if (!currentGroup || !manageGroupMembersList || !addGroupMemberSelect) return;
            
            fetch(`/groups/${currentGroup}/members`).then(res => res.json()).then(members => {
                // Render current members
                manageGroupMembersList.innerHTML = members.map(m => `
                    <div class="d-flex align-items-center mb-2 member-item">
                        <span class="me-2 member-name"><i class="fas fa-user"></i> ${m.name || m.user_id}</span>
                        ${m.is_admin ? '<span class="badge bg-primary ms-1">Admin</span>' : ''}
                        ${m.user_id !== currentUser ? `<button class='btn btn-sm btn-danger ms-auto remove-member-btn' data-user-id='${m.user_id}'>Remove</button>` : ''}
                    </div>
                `).join('');
                
                // Get all users and filter out current members
                const allUserIds = Array.from(document.querySelectorAll('.user-item')).map(i => i.dataset.userId);
                const memberIds = members.map(m => m.user_id);
                const usersToAdd = allUserIds.filter(uid => !memberIds.includes(uid));
                
                // Render users to add with checkboxes
                addGroupMemberSelect.innerHTML = usersToAdd.map(uid => {
                    const name = document.querySelector(`.user-item[data-user-id='${uid}'] .user-name-text`)?.textContent;
                    return `
                        <div class="form-check member-checkbox">
                            <input class="form-check-input" type="checkbox" value="${uid}" id="add-group-member-${uid}">
                            <label class="form-check-label" for="add-group-member-${uid}">${name}</label>
                        </div>
                    `;
                }).join('');
                
                // Initialize search and select all functionality
                initCurrentMembersSearch();
                initNewMembersSearch();
                initSelectAllMembers();
                
                manageGroupModal.show();
            });
        });
    }

    // Remove member
    if (manageGroupMembersList) {
        manageGroupMembersList.addEventListener('click', function(e) {
            if (e.target.classList.contains('remove-member-btn')) {
                const userId = e.target.dataset.userId;
                fetch(`/groups/${currentGroup}/members`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: userId, admin_id: currentUser })
                }).then(res => res.json()).then(data => {
                    if (data.success) {
                        manageGroupModal.hide();
                        loadGroups();
                    }
                });
            }
        });
    }

    // Add new members
    if (addGroupMemberBtn) {
        addGroupMemberBtn.addEventListener('click', function() {
            const newMemberIds = Array.from(addGroupMemberSelect?.querySelectorAll('input:checked') || []).map(i => i.value);
            Promise.all(newMemberIds.map(uid => fetch(`/groups/${currentGroup}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: uid, admin_id: currentUser })
            }))).then(() => {
                manageGroupModal.hide();
                loadGroups();
            });
        });
    }

    function initCurrentMembersSearch() {
        const searchCurrentMembers = document.getElementById('searchCurrentMembers');
        if (!searchCurrentMembers) return;
        
        // Create no results message element upfront
        let noResultsMsg = document.getElementById('noCurrentMembersFound');
        if (!noResultsMsg) {
            noResultsMsg = document.createElement('div');
            noResultsMsg.id = 'noCurrentMembersFound';
            noResultsMsg.className = 'text-center text-muted my-2';
            noResultsMsg.textContent = 'No current members found';
            noResultsMsg.style.display = 'none';
            const manageGroupMembersList = document.getElementById('manageGroupMembersList');
            if (manageGroupMembersList) {
                manageGroupMembersList.insertBefore(noResultsMsg, manageGroupMembersList.firstChild);
            }
        }
        
        searchCurrentMembers.addEventListener('input', function() {
            const query = this.value.toLowerCase().trim();
            
            if (!query) {
                // Show all items when search is empty
                document.querySelectorAll('#manageGroupMembersList .member-item').forEach(item => {
                    item.style.display = 'flex';
                });
                noResultsMsg.style.display = 'none';
                return;
            }
            
            let found = false;
            document.querySelectorAll('#manageGroupMembersList .member-item').forEach(item => {
                // Get all text content from the member item (excluding buttons)
                const memberText = item.textContent.toLowerCase();
                
                // Remove button text to avoid searching "Remove" text
                const cleanText = memberText.replace(/remove/gi, '').replace(/admin/gi, '');
                
                if (cleanText.includes(query)) {
                    item.style.display = 'flex';
                    found = true;
                } else {
                    item.style.display = 'none';
                }
            });
            
            noResultsMsg.style.display = found ? 'none' : 'block';
        });
        
        // Clear search on escape
        searchCurrentMembers.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                this.value = '';
                this.dispatchEvent(new Event('input'));
            }
        });
    }

    function initNewMembersSearch() {
        const searchNewMembers = document.getElementById('searchNewMembers');
        if (!searchNewMembers) return;
        
        searchNewMembers.addEventListener('input', function() {
            const query = this.value.toLowerCase().trim();
            const memberCheckboxes = document.querySelectorAll('#addGroupMemberSelect .form-check');
            
            let found = false;
            memberCheckboxes.forEach(checkbox => {
                const label = checkbox.querySelector('.form-check-label');
                if (label) {
                    const text = label.textContent.toLowerCase();
                    if (text.includes(query)) {
                        checkbox.style.display = 'block';
                        found = true;
                    } else {
                        checkbox.style.display = 'none';
                    }
                }
            });
            
            // Show/hide "no results" message
            let noResultsMsg = document.getElementById('noNewMembersFound');
            if (!found) {
                if (!noResultsMsg) {
                    noResultsMsg = document.createElement('div');
                    noResultsMsg.id = 'noNewMembersFound';
                    noResultsMsg.className = 'text-center text-muted my-2';
                    noResultsMsg.textContent = 'No employees found';
                    const addGroupMemberSelect = document.getElementById('addGroupMemberSelect');
                    if (addGroupMemberSelect) addGroupMemberSelect.appendChild(noResultsMsg);
                }
            } else if (noResultsMsg) {
                noResultsMsg.remove();
            }
        });
    }

    // Select All functionality
    function initSelectAllMembers() {
        const selectAllCheckbox = document.getElementById('selectAllMembers');
        if (!selectAllCheckbox) return;
        
        selectAllCheckbox.addEventListener('change', function() {
            const checkboxes = document.querySelectorAll('#addGroupMemberSelect .form-check-input');
            checkboxes.forEach(checkbox => {
                checkbox.checked = this.checked;
            });
        });
    }

    function sendGroupMessage() {
        if (sending) return;
        const content = messageInput?.value.trim();
        if ((!content && !currentImageData && !pendingAttachments.length) || !currentGroup) return;

        if (pendingAttachments.length > 1 || (pendingAttachments.length === 1 && currentImageData)) {
            return sendGroupWithAttachments(content);
        }

        sending = true;
        let messageData = {
            sender_id: currentUser,
            group_id: currentGroup,
            content: content || '',
            filename: currentImageData ? currentImageData.name : '',
            type: replyingTo ? 'reply' : (currentImageData ? ((currentImageData.type || '').startsWith('image/') ? 'image' : 'file') : 'text'),
            parent_message_id: replyingTo
        };
        if (currentImageData) {
            const previewContainer = document.getElementById('image-preview-container');
            if (previewContainer) {
                previewContainer.innerHTML = `<div class=\"attachment-preview loading\"><i class=\"fas fa-image fa-spin\"></i><span class=\"file-name\">${currentImageData.name}</span><div class=\"loading-text\">Sending...</div></div>`;
            }
            messageData.media_url = currentImageData.data;
        }
        socket.emit('send_group_message', messageData, (response) => {
            sending = false;
            if (response && response.error) {
                alert('Failed to send message: ' + response.error);
                if (currentImageData) {
                    updateImagePreview(currentImageData.data);
                }
            } else {
                if (messageInput) messageInput.value = '';
                if (currentImageData) {
                    currentImageData = null;
                    pendingAttachments = [];
                    clearAttachmentsPreview();
                }
                if (replyingTo) {
                    cancelReply();
                }
                // Sorting removed
            }
        });
    }

    function sendGroupWithAttachments(content) {
        if (sending) return;
        const queue = pendingAttachments.slice();
        const hasText = !!(content && content.trim());
        let index = 0;
        sending = true;
        const sendNext = () => {
            if (index >= queue.length) {
                sending = false;
                pendingAttachments = [];
                currentImageData = null;
                clearAttachmentsPreview();
                if (messageInput) messageInput.value = '';
                if (replyingTo) cancelReply();
                // Sorting removed
                return;
            }
            const att = queue[index];
            const isImage = (att.type || '').startsWith('image/');
            const messageData = {
                sender_id: currentUser,
                group_id: currentGroup,
                content: (index === 0 && hasText) ? content : '',
                filename: att.name || '',
                type: replyingTo ? 'reply' : (isImage ? 'image' : 'file'),
                parent_message_id: replyingTo,
                media_url: att.data
            };
            socket.emit('send_group_message', messageData, (response) => {
                if (response && response.error) {
                    sending = false;
                    try { showToast('Error', 'Failed to send one of the attachments'); } catch (_) {}
                    return;
                }
                index++;
                sendNext();
            });
        };
        sendNext();
    }

    // Toggle between direct and group chat
    function showDirectChat() {
        if (!toggleDirectChatBtn || !toggleGroupChatBtn || !directChatSearchBox || !groupChatSearchBox || !groupListUI || !groupCreateBtnRow) return;
        
        toggleDirectChatBtn.classList.add('active');
        toggleGroupChatBtn.classList.remove('active');
        
        const activeUsersList = document.getElementById('active-users-list');
        if (activeUsersList) activeUsersList.classList.remove('d-none');
        
        directChatSearchBox.classList.remove('d-none');
        groupListUI.classList.add('d-none');
        groupChatSearchBox.classList.add('d-none');
        groupCreateBtnRow.classList.add('d-none');

        // If a direct peer is selected, refresh their status; otherwise hide
        if (currentReceiver) {
            updateChatWithStatus(currentReceiver);
        } else {
            hideChatStatus();
        }
    }

    function showGroupChat() {
        if (!toggleDirectChatBtn || !toggleGroupChatBtn || !directChatSearchBox || !groupChatSearchBox || !groupListUI || !groupCreateBtnRow) return;
        
        toggleDirectChatBtn.classList.remove('active');
        toggleGroupChatBtn.classList.add('active');
        
        const activeUsersList = document.getElementById('active-users-list');
        if (activeUsersList) activeUsersList.classList.add('d-none');
        
        directChatSearchBox.classList.add('d-none');
        groupListUI.classList.remove('d-none');  // Show group list
        groupChatSearchBox.classList.remove('d-none');
        groupCreateBtnRow.classList.remove('d-none');
        
        // Load groups when switching to group chat mode
        loadGroups();

        // Never show presence in group chats
        hideChatStatus();
    }

    if (toggleDirectChatBtn) {
        toggleDirectChatBtn.addEventListener('click', showDirectChat);
    }

    if (toggleGroupChatBtn) {
        toggleGroupChatBtn.addEventListener('click', showGroupChat);
    }

    // --- Keyboard Shortcuts ---
    function isTypingField(el) {
        if (!el) return false;
        const tag = (el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    }

    function visibleItems(nodeList) {
        return Array.from(nodeList).filter(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
    }

    function navigateChats(delta) {
        // Determine current mode by sidebar visibility
        const isGroupMode = groupListUI && !groupListUI.classList.contains('d-none');
        if (isGroupMode) {
            const items = visibleItems(document.querySelectorAll('#group-list .group-item'));
            if (!items.length) return;
            const currentIdx = items.findIndex(li => li.classList.contains('active'));
            const nextIdx = (currentIdx >= 0 ? (currentIdx + delta + items.length) % items.length : (delta > 0 ? 0 : items.length - 1));
            const target = items[nextIdx];
            const gid = Number(target.dataset.groupId);
            const gname = target.querySelector('.group-name-text')?.textContent || `Group ${gid}`;
            switchToGroup(gid, gname);
            target.scrollIntoView({ block: 'nearest' });
        } else {
            const items = visibleItems(document.querySelectorAll('#active-users-list .user-item'));
            if (!items.length) return;
            const currentIdx = items.findIndex(li => li.classList.contains('active'));
            const nextIdx = (currentIdx >= 0 ? (currentIdx + delta + items.length) % items.length : (delta > 0 ? 0 : items.length - 1));
            const target = items[nextIdx];
            const uid = target.dataset.userId;
            switchToUser(uid);
            target.scrollIntoView({ block: 'nearest' });
        }
    }

    function focusActiveSearch() {
        const isGroupMode = groupListUI && !groupListUI.classList.contains('d-none');
        if (isGroupMode) {
            const el = document.getElementById('groupSearch');
            if (el) { el.focus(); el.select && el.select(); }
        } else {
            const el = document.getElementById('userSearch');
            if (el) { el.focus(); el.select && el.select(); }
        }
    }

    function clearActiveSearchOrClose() {
        // Close emoji picker if open
        if (emojiPicker && !emojiPicker.classList.contains('d-none')) {
            emojiPicker.classList.add('d-none');
            return true;
        }
        // Close shortcuts modal if open
        if (shortcutsModal && document.getElementById('shortcutsModal')?.classList.contains('show')) {
            shortcutsModal.hide();
            return true;
        }
        // Clear visible search box if it has content
        const isGroupMode = groupListUI && !groupListUI.classList.contains('d-none');
        const el = document.getElementById(isGroupMode ? 'groupSearch' : 'userSearch');
        if (el && el.value) {
            el.value = '';
            el.dispatchEvent(new Event('input'));
            return true;
        }
        return false;
    }

    function toggleEmojiPicker() {
        if (!emojiPicker) return;
        emojiPicker.classList.toggle('d-none');
        if (!emojiPicker.classList.contains('d-none')) {
            // ensure focus remains on message input for typing
            messageInput && messageInput.focus();
        }
    }

    function replyToLastMessage() {
        // Prefer last clicked message; fallback to last message in DOM
        let targetId = lastInteractedMessageId;
        if (!targetId) {
            const all = messagesContainer ? messagesContainer.querySelectorAll('.message') : [];
            const last = all.length ? all[all.length - 1] : null;
            targetId = last && last.dataset ? last.dataset.messageId : null;
        }
        if (targetId) {
            if (typeof window.handleReply === 'function') {
                window.handleReply(targetId);
            }
        }
    }

    document.addEventListener('keydown', (e) => {
        const activeEl = document.activeElement;
        const modalOpen = !!document.querySelector('.modal.show');

        // ESC always tries to close/clear
        if (e.key === 'Escape') {
            if (clearActiveSearchOrClose()) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        // Ignore non-Alt shortcuts while typing
        if (!e.altKey) return;

        // Allow Alt-combos even when typing, but avoid when a modal with focused input is open
        if (modalOpen && isTypingField(activeEl)) return;

        // Normalize key
        const k = (e.key || '').toLowerCase();

        if (k === 'arrowup') {
            e.preventDefault();
            navigateChats(-1);
            return;
        }
        if (k === 'arrowdown') {
            e.preventDefault();
            navigateChats(1);
            return;
        }
        if (k === 's') {
            e.preventDefault();
            focusActiveSearch();
            return;
        }
        if (k === 'u') {
            e.preventDefault();
            imageUpload && imageUpload.click();
            return;
        }
        if (k === 'e') {
            e.preventDefault();
            toggleEmojiPicker();
            return;
        }
        if (k === 'r') {
            e.preventDefault();
            replyToLastMessage();
            return;
        }
    }, true);

    // Group search filter
    if (groupSearchInput) {
        groupSearchInput.addEventListener('input', function () {
            const query = this.value.trim().toLowerCase();
            let found = false;
            document.querySelectorAll('#group-list .group-item').forEach(item => {
                const label = item.querySelector('.group-name-text')?.textContent.toLowerCase();
                if (label?.includes(query)) {
                    item.style.display = '';
                    found = true;
                } else {
                    item.style.display = 'none';
                }
            });
            
            let noGroupsMsg = document.getElementById('noGroupsFound');
            if (!found) {
                if (!noGroupsMsg) {
                    noGroupsMsg = document.createElement('li');
                    noGroupsMsg.id = 'noGroupsFound';
                    noGroupsMsg.className = 'list-group-item text-center text-muted';
                    noGroupsMsg.textContent = 'No groups found';
                    if (groupListUI) groupListUI.appendChild(noGroupsMsg);
                }
            } else if (noGroupsMsg) {
                noGroupsMsg.remove();
            }
        });
    }

    // Pin/unpin message functionality
    window.handlePin = function(messageId, forceUnpin = false, explicitGroupId = null) {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageElement) return;
        
        const isPinned = messageElement.querySelector('.pin-btn')?.classList.contains('pinned') || forceUnpin;
        
        // Determine if it's a group or direct message
        const groupDataAttr = messageElement.getAttribute('data-group-id');
        const groupIdForUnpin = explicitGroupId || (groupDataAttr ? Number(groupDataAttr) : null);
        const isGroupMessage = !!groupIdForUnpin || messageElement.dataset.groupId || 
                             (currentGroup && messageElement.closest('.group-chat'));
        
        const endpoint = isGroupMessage ? 
            `/groups/${groupIdForUnpin || currentGroup}/messages/pin` : 
            '/messages/pin';
        
        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message_id: messageId, 
                pin: forceUnpin ? false : !isPinned,
                ...(isGroupMessage && { group_id: (groupIdForUnpin || currentGroup) })
            })
        }).then(res => res.json()).then(data => {
            if (data.success) {
                // Server broadcasts; optimistic UI update for responsiveness
                updatePinUI(messageId, forceUnpin ? false : !isPinned);
                // If this was triggered from the pinned modal, remove card immediately
                try {
                    const card = document.querySelector(`#pinnedMessagesList [data-message-id="${messageId}"]`);
                    if (card) {
                        card.remove();
                        const list = document.getElementById('pinnedMessagesList');
                        if (list && list.querySelectorAll('.pinned-message-item').length === 0) {
                            list.innerHTML = '<div class="empty-state">No pinned messages found</div>';
                        }
                    }
                } catch (_) {}
            }
        });
    };

    function updatePinUI(messageId, pinned) {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageElement) return;
    
        const pinBtn = messageElement.querySelector('.pin-btn');
        const pinIcon = pinBtn ? pinBtn.querySelector('i.fa-thumbtack') : null;
        const pinnedLabel = messageElement.querySelector('.pinned-label');
    
        if (pinned) {
            messageElement.classList.add('pinned-message');
            if (pinBtn) {
                pinBtn.classList.add('pinned');
                pinBtn.title = 'Unpin this message';
            }
            if (pinIcon) {
                pinIcon.classList.add('text-warning');
                pinIcon.style.transform = 'rotate(-20deg)';
            }
            // Add or update pinned label if it doesn't exist
            if (!pinnedLabel) {
                const metadata = messageElement.querySelector('.metadata');
                if (metadata) {
                    metadata.insertAdjacentHTML('beforeend', 
                        `<span class="pinned-label badge bg-warning text-dark ms-2" title="Pinned">
                            <i class="fas fa-thumbtack"></i> Pinned
                        </span>`
                    );
                }
            }
        } else {
            messageElement.classList.remove('pinned-message');
            if (pinBtn) {
                pinBtn.classList.remove('pinned');
                pinBtn.title = 'Pin this message';
            }
            if (pinIcon) {
                pinIcon.classList.remove('text-warning');
                pinIcon.style.transform = '';
            }
            // Remove pinned label if it exists
            if (pinnedLabel) {
                pinnedLabel.remove();
            }
        }
    }

    if (socket) {
        // For direct messages
        socket.on('message_pinned', ({ message_id, pinned }) => {
            updatePinUI(message_id, pinned);
        });
        
        // For group messages
        socket.on('group_message_pinned', ({ message_id, pinned }) => {
            updatePinUI(message_id, pinned);
        });

        // ✅ CRITICAL FIX: Add this function to handle real-time read status updates
        function updateMessageReadStatus(messageId) {
            const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
            if (!messageElement) return;
            
            // Only process direct messages (not group messages)
            const isGroupMessage = messageElement.querySelector('.seen-status-eye');
            if (isGroupMessage) return;
            
            if (!messageElement.classList.contains('sent')) return;
            
            // Find any status element and update it to read (green ✓✓)
            const status = messageElement.querySelector('.status');
            if (status) {
                status.textContent = '✓✓';
                status.classList.add('read');
            } else {
                // Create status element if it doesn't exist (green ✓✓)
                const meta = messageElement.querySelector('.metadata');
                if (meta) {
                    const timeElement = meta.querySelector('.time');
                    if (timeElement) {
                        timeElement.insertAdjacentHTML('afterend', '<span class="status read">✓✓</span>');
                    } else {
                        meta.insertAdjacentHTML('beforeend', '<span class="status read">✓✓</span>');
                    }
                }
            }
            
            // Mark the message as read for styling
            messageElement.classList.add('read');
        }

        // ✅ CRITICAL FIX: Enhanced socket event listeners for read receipts
        socket.on('message_delivered', ({ message_id }) => {
            const el = document.querySelector(`[data-message-id="${message_id}"]`);
            if (!el) return;
            
            // Only process direct messages (not group messages)
            const isGroupMessage = el.querySelector('.seen-status-eye');
            if (isGroupMessage) return;
            
            if (!el.classList.contains('sent')) return;
            
            // Find any status element and update it to delivered (grey ✓✓)
            const status = el.querySelector('.status');
            if (status) {
                status.textContent = '✓✓';
                status.classList.remove('read'); // Ensure it's not green yet
            } else {
                // Create status element if it doesn't exist (grey ✓✓)
                const meta = el.querySelector('.metadata');
                if (meta) {
                    const timeElement = meta.querySelector('.time');
                    if (timeElement) {
                        timeElement.insertAdjacentHTML('afterend', '<span class="status">✓✓</span>');
                    } else {
                        meta.insertAdjacentHTML('beforeend', '<span class="status">✓✓</span>');
                    }
                }
            }
            
            // Don't mark the message as read for styling - only delivered
            el.classList.remove('read');
        });

        socket.on('message_read', ({ message_id }) => {
            updateMessageReadStatus(message_id);
        });

    }

    // Pinned messages modal
    const pinnedMessagesBtn = document.getElementById('pinnedMessagesBtn');
    const pinnedMessagesModal = new bootstrap.Modal(document.getElementById('pinnedMessagesModal'));
    const pinnedMessagesList = document.getElementById('pinnedMessagesList');

    if (pinnedMessagesBtn) {
        pinnedMessagesBtn.addEventListener('click', function() {
            let url = '/messages/pinned?';
            if (currentGroup) {
                url += `group_id=${currentGroup}`;
            } else if (currentUser && currentReceiver) {
                url += `sender_id=${currentReceiver}&receiver_id=${currentUser}`;
            }
            
            fetch(url).then(res => res.json()).then(messages => {
                if (pinnedMessagesList) {
                    pinnedMessagesList.innerHTML = messages.length ? 
                        messages.map(renderPinnedMessage).join('') : 
                        '<div class="text-muted text-center py-4">No pinned messages found</div>';
                    pinnedMessagesModal.show();
                }
            });
        });
    }

    function renderPinnedMessage(msg) {
        const timestamp = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';
        const senderName = msg.sender_name || msg.sender_id || 'Unknown';
        const messageType = msg.type || msg.message_type;
        const mediaType = msg.media_type || '';
        const isForward = messageType === 'forward';
        let isImage = messageType === 'image' || (isForward && mediaType === 'image');
        let isFile = messageType === 'file' || (isForward && mediaType === 'file');
        // Fallback by extension when media_type missing on forwarded items
        if ((isForward && !mediaType) || (!isImage && !isFile)) {
            const url = String(msg.media_url || '').toLowerCase();
            if (url) {
                if (/\.(jpg|jpeg|png)$/.test(url)) isImage = true; else isFile = true;
            }
        }

        let innerHtml = '';
        if (isFile) {
            const fileName = msg.filename || 'Attachment';
            const size = typeof msg.file_size === 'number' ? formatBytes(msg.file_size) : '';
            innerHtml = `<div class="file-attachment">
                <div class="file-thumb">
                    <i class="${getFileIconClass(fileName)}"></i>
                </div>
                <div class="file-meta">
                    <div class="file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    ${size ? `<div class="file-size">${size}</div>` : ''}
                    <div class="file-actions">
                        <a href="/download/${msg.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                        <a href="/download/${msg.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                    </div>
                </div>
            </div>`;
        } else if (isImage && (msg.media_url || msg.filename)) {
            const fileName = msg.filename || 'Image attachment';
            innerHtml = `<div class="image-message-block">
                <div class="message-attachment" data-image-url="${msg.media_url && msg.media_url.startsWith('/static/') ? msg.media_url : `/static/${String(msg.media_url || '').replace(/^\/+/, '')}`}">
                    <i class="fas fa-paperclip"></i>
                    <span class="file-name">${escapeHtml(fileName)}</span>
                </div>
            </div>`;
        } else {
            let text = msg.content || '';
            if (text.length > 160) text = text.substring(0, 160) + '…';
            innerHtml = `<div class="pinned-content">${escapeHtml(text)}</div>`;
        }

        return `
        <div class="pinned-message-item pinned-card compact" data-message-id="${msg.id}">
            <div class="pinned-header">
                <div class="pinned-title">
                    <i class="fas fa-thumbtack pinned-icon"></i>
                    <span>${escapeHtml(senderName)}</span>
                </div>
                <div class="pinned-meta">${timestamp}</div>
            </div>
            ${innerHtml}
            ${msg.parent_message_id ? `<div class="pinned-meta mt-1">In reply to a message</div>` : ''}
            <button class="btn btn-sm btn-outline-secondary unpin-btn" onclick="handlePin('${msg.id}')" title="Unpin"><i class="fas fa-thumbtack me-1"></i> Unpin</button>
        </div>`;
    }

    if (pinnedMessagesList) {
        pinnedMessagesList.addEventListener('click', function(e) {
            if (e.target.closest('.unpin-btn')) {
                const msgDiv = e.target.closest('.pinned-message-item');
                const messageId = msgDiv?.dataset.messageId;
                if (messageId) {
                    handlePin(messageId, true); // force unpin
                    msgDiv.remove();
                    
                    // If no more pinned messages, show empty state
                    if (pinnedMessagesList.querySelectorAll('.pinned-message-item').length === 0) {
                        pinnedMessagesList.innerHTML = '<div class="empty-state">No pinned messages found</div>';
                    }
                }
            }
            
            // Click on message to jump to it
            const messageItem = e.target.closest('.pinned-message-item');
            if (messageItem && !e.target.closest('.unpin-btn')) {
                const messageId = messageItem.dataset.messageId;
                const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
                if (msgEl) {
                    msgEl.classList.add('highlighted');
                    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => msgEl.classList.remove('highlighted'), 2000);
                    pinnedMessagesModal.hide();
                }
            }
        });
    }

    // Search messages functionality
    const searchMessagesBtn = document.getElementById('searchMessagesBtn');
    const searchMessagesModal = new bootstrap.Modal(document.getElementById('searchMessagesModal'));
    const searchMessagesForm = document.getElementById('searchMessagesForm');
    const searchMessagesInput = document.getElementById('searchMessagesInput');
    const searchMessagesResults = document.getElementById('searchMessagesResults');
    
    if (searchMessagesBtn) {
        searchMessagesBtn.addEventListener('click', function() {
            if (searchMessagesInput) searchMessagesInput.value = '';
            if (searchMessagesResults) searchMessagesResults.innerHTML = '';
            searchMessagesModal.show();
            if (searchMessagesInput) searchMessagesInput.focus();
        });
    }
    
    if (searchMessagesForm) {
        searchMessagesForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const query = searchMessagesInput?.value.trim();
            if (!query) return;
            
            let url = `/messages/search?query=${encodeURIComponent(query)}`;
            if (currentGroup) {
                url += `&group_id=${currentGroup}`;
            } else if (currentUser && currentReceiver) {
                url += `&sender_id=${currentUser}&receiver_id=${currentReceiver}`;
            }
            
            fetch(url).then(res => res.json()).then(messages => {
                try {
                    // Dedupe by id and keep most recent first
                    const seen = new Set();
                    const ordered = (Array.isArray(messages) ? messages : []).filter(m => {
                        if (!m || m.id == null) return false;
                        if (seen.has(m.id)) return false;
                        seen.add(m.id);
                        return true;
                    });
                    if (searchMessagesResults) {
                        searchMessagesResults.innerHTML = ordered.length ? ordered.map(renderSearchResult).join('') : '<div class="empty-state">No results found.</div>';
                    }
                } catch (_) {
                    if (searchMessagesResults) searchMessagesResults.innerHTML = '<div class="empty-state">No results found.</div>';
                }
            });
        });
    }

    function renderSearchResult(msg) {
        const isPinned = !!msg.pinned;
        const when = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';
        const from = msg.sender_name || msg.sender_id || '';
        const messageType = msg.type || msg.message_type;
        const mediaType = msg.media_type || '';
        const isForward = messageType === 'forward';
        let isImage = messageType === 'image' || (isForward && mediaType === 'image');
        let isFile = messageType === 'file' || (isForward && mediaType === 'file');
        if ((isForward && !mediaType) || (!isImage && !isFile)) {
            const url = String(msg.media_url || '').toLowerCase();
            if (url) {
                if (/\.(jpg|jpeg|png)$/.test(url)) isImage = true; else isFile = true;
            }
        }

        let bodyHtml = '';
        if (isFile) {
            const fileName = msg.filename || 'Attachment';
            const size = typeof msg.file_size === 'number' ? formatBytes(msg.file_size) : '';
            bodyHtml = `<div class="file-attachment">
                <div class="file-thumb">
                    <i class="${getFileIconClass(fileName)}"></i>
                </div>
                <div class="file-meta">
                    <div class="file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    ${size ? `<div class="file-size">${size}</div>` : ''}
                    <div class="file-actions">
                        <a href="/download/${msg.id}" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Download</a>
                        <a href="/download/${msg.id}?inline=1" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> Open</a>
                    </div>
                </div>
            </div>`;
        } else if (isImage && (msg.media_url || msg.filename)) {
            const fileName = msg.filename || 'Image attachment';
            bodyHtml = `<div class="image-message-block">
                <div class="message-attachment" data-image-url="${msg.media_url && msg.media_url.startsWith('/static/') ? msg.media_url : `/static/${String(msg.media_url || '').replace(/^\/+/, '')}`}">
                    <i class="fas fa-paperclip"></i>
                    <span class="file-name">${escapeHtml(fileName)}</span>
                </div>
            </div>`;
        } else {
            let text = msg.content || '';
            if (text.length > 180) text = text.substring(0, 180) + '…';
            bodyHtml = `<div class="result-content">${escapeHtml(text)}</div>`;
        }

        const icon = isImage ? 'fa-image' : (isFile ? 'fa-paperclip' : 'fa-message');
        return `
        <div class="search-result result-card compact" data-message-id="${msg.id}">
            <div class="result-header">
                <div class="result-title">
                    <i class="fas ${icon} result-icon"></i>
                    <span>${from ? escapeHtml(from) : 'Message'}</span>
                </div>
                <div class="result-meta">${when} ${isPinned ? '<span class="ms-2" title="Pinned"><i class="fas fa-thumbtack"></i></span>' : ''}</div>
            </div>
            ${bodyHtml}
        </div>`;
    }
    
    if (searchMessagesResults) {
        searchMessagesResults.addEventListener('click', function(e) {
            const result = e.target.closest('.search-result');
            if (result && result.dataset.messageId) {
                const msgId = result.dataset.messageId;
                const msgEl = document.querySelector(`[data-message-id="${msgId}"]`);
                if (msgEl) {
                    msgEl.classList.add('highlighted');
                    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => msgEl.classList.remove('highlighted'), 2000);
                    searchMessagesModal.hide();
                }
            }
        });
    }

    // Welcome card functions
    function hideWelcomeCard() {
        if (welcomeCard) welcomeCard.classList.add('hidden');
        if (virtualScrollContainer) virtualScrollContainer.style.display = 'block';
        if (chatHeader) chatHeader.style.display = 'block';
        if (chatFooter) chatFooter.style.display = 'block';
    }

    function showWelcomeCard() {
        if (welcomeCard) welcomeCard.classList.remove('hidden');
        if (virtualScrollContainer) virtualScrollContainer.style.display = 'none';
        if (chatHeader) chatHeader.style.display = 'none';
        if (chatFooter) chatFooter.style.display = 'none';
    }

    // Show welcome card by default when page loads
    showWelcomeCard();

    // Load groups after initialization
    loadGroups();

    // Logout handler
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            fetch('/logout', { method: 'POST' }).then(() => {
                window.location.href = '/login';
            });
        });
    }
});

// Make removeImagePreview globally available
window.removeImagePreview = function() {
    const event = new Event('removeImagePreview');
    document.dispatchEvent(event);
};

function handleImageError(img) {
    if (!img || !img.src) return;
    showToast("Image Missing", "This image is no longer available or has been deleted.");
    img.src = "/static/images/error-image.png"; // Make sure this fallback image exists
    img.alt = "Image not found";
}