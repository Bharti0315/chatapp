import os
import re
import uuid
import base64
import imghdr
import emoji
import secrets
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import (
Flask, render_template, request, jsonify, session,
send_from_directory, redirect, url_for, abort
)
import mimetypes
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename, safe_join
from database import Database


def convert_datetime(obj):
    if isinstance(obj, dict):
        return {k: convert_datetime(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_datetime(i) for i in obj]
    elif isinstance(obj, datetime):
        return obj.isoformat()
    return obj

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('user_id'):
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated_function

app = Flask(__name__)
# Core configuration (env-overridable for deployment)
app.config['SECRET_KEY'] = 
app.config['MAX_CONTENT_LENGTH'] = 
app.config['UPLOAD_FOLDER'] = 
app.config['FILES_UPLOAD_FOLDER'] = 
app.config['JSON_SORT_KEYS'] = 
app.config['JSON_AS_ASCII'] = 
app.config['PREFERRED_URL_SCHEME'] = 


# Socket.IO: prefer eventlet if available; allow tuning via env
_async_mode = os.getenv('SOCKETIO_ASYNC_MODE') or None  # let flask-socketio choose best
socketio = SocketIO(
    app,
    cors_allowed_origins=os.getenv('CORS_ALLOWED_ORIGINS', '*'),
    async_mode=_async_mode,
    ping_interval=float(os.getenv('SOCKETIO_PING_INTERVAL', '25')),
    ping_timeout=float(os.getenv('SOCKETIO_PING_TIMEOUT', '60')),
    max_http_buffer_size=app.config['MAX_CONTENT_LENGTH']  # cap payloads
)
db = Database()
db.create_tables()


# Ensure upload directories exist
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['FILES_UPLOAD_FOLDER'], exist_ok=True)

# Optional: compression (best-effort)
try:
    from flask_compress import Compress  # type: ignore
    Compress(app)
except Exception:
    pass

# Security headers for basic hardening
@app.after_request
def add_security_headers(resp):
    try:
        resp.headers['X-Content-Type-Options'] = 'nosniff'
        resp.headers['X-Frame-Options'] = 'SAMEORIGIN'
        resp.headers['X-XSS-Protection'] = '1; mode=block'
        resp.headers['Referrer-Policy'] = 'same-origin'
        resp.headers['Cache-Control'] = resp.headers.get('Cache-Control', 'no-store')
        # CSP tuned for used CDNs and Google Fonts (style + font fetching)
        csp_parts = [
            "default-src 'self'",
            "img-src 'self' data: blob: https:",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.socket.io",
            "script-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.socket.io",
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
            "style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
            "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
            # Service worker and runtime fetch allowances (Bootstrap/FA from CDNs)
            "connect-src 'self' ws: wss: https://cdn.socket.io https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com",
        ]
        csp = '; '.join(csp_parts)
        resp.headers['Content-Security-Policy'] = resp.headers.get('Content-Security-Policy', csp)
    except Exception:
        pass
    return resp

"""
Allowed types
- images: only jpeg/jpg and png (gif/webp removed per requirement)
- documents: pdf, word, excel
"""
ALLOWED_IMAGE_TYPES = {'jpeg', 'jpg', 'png'}
ALLOWED_DOC_EXTS = {
    'pdf',
    'doc', 'docx',
    'xls', 'xlsx'
}

ALLOWED_DOC_MIME_PREFIXES = {
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

def save_uploaded_file(file_data, original_filename):
    """Save uploaded image or document to filesystem with dedup by hash.

    Returns (True, relative_path) or (False, error_msg)
    relative_path is under 'uploads/images' or 'uploads/files'
    """
    try:
        mime = None
        data = file_data
        if file_data.startswith('data:'):
            # Extract mime and base64 payload
            m = re.match(r'^data:([^;]+);base64,(.*)$', file_data)
            if not m:
                return False, 'Invalid data URL'
            mime = m.group(1).lower()
            data = m.group(2)

        try:
            file_bytes = base64.b64decode(data)
        except Exception:
            return False, 'Invalid file data'

        if len(file_bytes) > app.config['MAX_CONTENT_LENGTH']:
            return False, f"File size exceeds {app.config['MAX_CONTENT_LENGTH'] / (1024 * 1024)}MB"

        # Determine type and extension
        filename = secure_filename(original_filename or 'attachment')
        ext = os.path.splitext(filename)[1].lower().lstrip('.')

        # Heuristic: if image/* or imghdr detects image -> treat as image
        file_type = imghdr.what(None, file_bytes)
        is_image = False
        if mime and mime.startswith('image/'):
            is_image = True
        if file_type:
            is_image = True

        if is_image:
            # Restrict to jpeg/jpg/png
            kind = (file_type or '').lower()
            if not kind and mime:
                kind = mime.split('/')[-1]
            if kind == 'jpg':
                kind = 'jpeg'
            if kind not in ALLOWED_IMAGE_TYPES:
                return False, 'Invalid image format. Allowed: JPEG, PNG'
            # Normalize extension
            ext = 'jpg' if kind == 'jpeg' else 'png'
            base_dir = app.config['UPLOAD_FOLDER']
            # Always use forward slashes for stored URLs
            rel_dir = 'uploads/images'
        else:
            # Documents
            # Validate by mime or extension
            valid_by_mime = (mime in ALLOWED_DOC_MIME_PREFIXES) if mime else False
            valid_by_ext = ext in ALLOWED_DOC_EXTS
            if not (valid_by_mime or valid_by_ext):
                return False, 'Unsupported file type. Allowed: PDF, Word, Excel'

            # Basic signature checks to reduce spoofing
            if ext == 'pdf' and not file_bytes.startswith(b'%PDF'):
                return False, 'Invalid PDF file'
            if ext in {'docx', 'xlsx'} and not file_bytes.startswith(b'PK'):
                return False, 'Invalid Office file'
            if ext in {'doc', 'xls'} and not (file_bytes[:8] == b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"):
                # Old OLE header
                return False, 'Invalid legacy Office file'

            base_dir = app.config['FILES_UPLOAD_FOLDER']
            # Always use forward slashes for stored URLs
            rel_dir = 'uploads/files'

        # Deduplicate by content hash
        import hashlib
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        dedup_filename = f"{file_hash}.{ext}" if ext else file_hash
        file_path = os.path.join(base_dir, dedup_filename)

        if not os.path.exists(file_path):
            with open(file_path, 'wb') as f:
                f.write(file_bytes)

        # Return URL-ish path with forward slashes regardless of OS
        return True, f"{rel_dir}/{dedup_filename}"
    except Exception as e:
        app.logger.error(f"Error saving file: {str(e)}", exc_info=True)
        return False, f"Error processing file: {str(e)}"

@app.route('/offline.html')
def offline_page():
    # Serve offline template for PWA fallback
    return render_template('offline.html')

@app.route('/sw.js')
def service_worker():
    return send_from_directory('.', 'sw.js', mimetype='application/javascript')

@app.route('/static/<path:filename>')
def serve_static(filename):
    """Serve static files safely with fallback for legacy image names"""
    try:
        # Ensure the requested path resolves under the static directory
        safe_path = safe_join(app.root_path, 'static', filename)
        if safe_path and os.path.exists(safe_path):
            # Use the original subpath for send_from_directory
            return send_from_directory('static', filename)

        # Legacy fallback: try to match uploads by basename only (images)
        if filename.startswith('uploads/images/'):
            legacy_name = os.path.basename(filename)
            uploads_dir = os.path.join(app.root_path, 'static', 'uploads', 'images')
            if os.path.exists(uploads_dir):
                for f in os.listdir(uploads_dir):
                    if f.endswith(legacy_name):
                        return send_from_directory(uploads_dir, f)

        # Legacy fallback for files
        if filename.startswith('uploads/files/'):
            legacy_name = os.path.basename(filename)
            files_dir = os.path.join(app.root_path, 'static', 'uploads', 'files')
            if os.path.exists(files_dir):
                for f in os.listdir(files_dir):
                    if f.endswith(legacy_name):
                        return send_from_directory(files_dir, f)

        app.logger.warning(f"[404] File not found: {filename}")
        return send_from_directory('static/images', 'error-image.png'), 404
    except Exception as e:
        app.logger.error(f"Error serving static file {filename}: {str(e)}", exc_info=True)
        return jsonify({'error': 'File not found'}), 404

# Dedicated download endpoint to force friendly filenames
@app.route('/download/<int:message_id>')
def download_message_file(message_id):
    try:
        message = db.get_message_by_id(message_id)
        if not message:
            abort(404)
        media_url = message.get('media_url')
        filename = message.get('filename') or os.path.basename(media_url or '')
        if not media_url:
            abort(404)

        # Normalize relative path to disk path (handle leading '/' and backslashes)
        rel = media_url
        rel = rel.replace('\\', '/')
        if rel.startswith('/'):
            rel = rel[1:]
        if rel.startswith('static/'):
            rel = rel[len('static/'):]
        # Some rows may accidentally prefix text before 'uploads/...'
        uploads_idx = rel.find('uploads/')
        if uploads_idx > 0:
            rel = rel[uploads_idx:]
        disk_path = safe_join(app.root_path, 'static', rel)

        # Fallback: search by basename in images/files directories if path missing
        if not disk_path or not os.path.exists(disk_path):
            base = os.path.basename(rel)
            candidates = [
                os.path.join(app.root_path, 'static', 'uploads', 'files', base),
                os.path.join(app.root_path, 'static', 'uploads', 'images', base)
            ]
            found = None
            for c in candidates:
                if os.path.exists(c):
                    found = c
                    break
            if not found:
                # try search by extension match (hash names scenario)
                files_dir = os.path.join(app.root_path, 'static', 'uploads', 'files')
                images_dir = os.path.join(app.root_path, 'static', 'uploads', 'images')
                for d in (files_dir, images_dir):
                    if os.path.isdir(d):
                        for f in os.listdir(d):
                            if os.path.splitext(f)[1].lower() == os.path.splitext(base)[1].lower():
                                found = os.path.join(d, f)
                                break
                    if found:
                        break
            disk_path = found

        if not disk_path or not os.path.exists(disk_path):
            abort(404)

        directory = os.path.dirname(disk_path)
        basename = os.path.basename(disk_path)

        inline = request.args.get('inline') == '1'
        guessed_type, _ = mimetypes.guess_type(filename or basename)
        as_attachment = not inline
        return send_from_directory(
            directory,
            basename,
            as_attachment=as_attachment,
            download_name=filename,
            mimetype=guessed_type or None
        )
    except Exception:
        app.logger.exception('download_message_file failed')
        abort(404)

# --- AUTH ROUTES ---
@app.route('/login', methods=['GET'])
def login_page():
    if session.get('user_id'):
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/login', methods=['POST'])
def login_action():
    data = request.get_json(silent=True) or request.form
    emp_id = (data.get('emp_id') or '').strip()
    password = data.get('password') or ''
    if not emp_id or not password:
        return jsonify({'error': 'Missing credentials'}), 400

    user = db.verify_credentials(emp_id, password)
    if not user:
        return jsonify({'error': 'Invalid credentials'}), 401

    # Normalize values stored in session to avoid whitespace mismatches
    session['user_id'] = str(user.get('emp_id') or emp_id).strip()
    session['user_name'] = (user.get('name') or '').strip()
    session['login_session_id'] = session.get('login_session_id') or secrets.token_urlsafe(24)

    db.record_login(user['emp_id'], session['login_session_id'])
    return jsonify({'success': True})

@app.route('/logout', methods=['POST', 'GET'])
def logout_action():
    emp_id = session.get('user_id')
    if emp_id:
        db.record_logout(emp_id)
    session.clear()
    if request.method == 'GET':
        return redirect(url_for('login_page'))
    return jsonify({'success': True})

# Route for main chat
@app.route('/')
@login_required
def index():
    active_employees = db.get_active_employees()
    return render_template('index.html', employees=active_employees, current_user={
        'emp_id': session.get('user_id'),
        'name': session.get('user_name')
    })

@socketio.on('connect')
def handle_connect():
    user_id = (session.get('user_id') or '').strip()
    if not user_id:
        return False  # reject unauthenticated connections
    join_room(user_id)
    db.update_user_status(user_id, True)
    # Notify all clients about the user connection
    socketio.emit('user_connected', {'user_id': user_id})
    # Send initial unread counts for both direct and group messages
    unread_counts = db.get_user_unread_counts(user_id)
    group_unread_counts = db.get_user_group_unread_counts(user_id)
    combined_counts = {**unread_counts, **group_unread_counts}
    emit('unread_counts_update', combined_counts)

    # Auto-subscribe this socket to all group rooms the user belongs to.
    # This ensures real-time group events (including notifications) are received
    # even when the user is not actively viewing that group in the UI.
    try:
        groups = db.get_user_groups(user_id) or []
        for g in groups:
            gid = g.get('id')
            if gid is not None:
                join_room(f'group_{gid}')
    except Exception:
        app.logger.exception('Failed to join group rooms on connect')

@socketio.on('disconnect')
def handle_disconnect():
    user_id = session.get('user_id')
    if user_id:
        leave_room(user_id)
        db.update_user_status(user_id, False)
        # Notify all clients about the user disconnection
        socketio.emit('user_disconnected', {'user_id': user_id})

@socketio.on('send_message')
def handle_message(data):
    try:
        sender_id = session.get('user_id')
        if not sender_id:
            return {'error': 'Unauthorized'}
        receiver_id = data.get('receiver_id')
        content = data.get('content')
        message_type = data.get('type', 'text')
        parent_message_id = data.get('parent_message_id')
        media_url = data.get('media_url')
        media_type = data.get('media_type')
        file_size = None
        filename = data.get('filename')

        # ✅ Log only metadata, not full base64 payload
        app.logger.info(
        "[Direct] Received message from %s to %s | type=%s | filename=%s | has_media=%s",
        sender_id,
        receiver_id,
        message_type,
        filename,
        bool(media_url)
        )

        # Handle emoji conversion
        if message_type == 'text':
            content = emoji.emojize(content)

        # Handle attachment upload (image or document)
        if message_type in ('image', 'file') and media_url:
            is_valid, result = save_uploaded_file(media_url, filename or "attachment")
            if not is_valid:
                return {'error': result}
            media_url = result
            file_path = os.path.join('static', media_url)
            if os.path.exists(file_path):
                file_size = os.path.getsize(file_path)
            else:
                return {'error': 'Failed to save file'}
            # Normalize media_type
            media_type = 'image' if message_type == 'image' else 'file'
            if not filename and media_url:
                filename = os.path.basename(media_url)

        # Handle forwarded media
        if message_type == 'forward' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message and parent_message.get('media_url'):
                media_url = parent_message['media_url']
                media_type = parent_message.get('media_type') or (
                    'image' if str(media_url).lower().endswith(('.jpg', '.jpeg', '.png')) else 'file'
                )
                file_size = parent_message.get('file_size')
                if not filename:
                    filename = parent_message.get('filename') or os.path.basename(media_url)

        # Save the message
        message_id = db.save_message(
            sender_id=sender_id,
            receiver_id=receiver_id,
            content=content,
            message_type=message_type,
            parent_message_id=parent_message_id,
            media_url=media_url,
            media_type=media_type if media_type else (message_type if message_type == 'image' else None),
            file_size=file_size,
            filename=filename
        )
        if not message_id:
            return {'error': 'Failed to save message'}

        sender = db.get_employee_by_id(sender_id)
        current_utc = datetime.now(timezone.utc)
        timestamp = current_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')

        message_data = {
            'id': message_id,
            'sender_id': sender_id,
            'sender_name': sender['name'] if sender else 'Unknown',
            'receiver_id': receiver_id,
            'content': content,
            'type': message_type,
            'parent_message_id': parent_message_id,
            'media_url': media_url,
            'media_type': media_type,
            'filename': filename,
            'file_size': file_size,
            'timestamp': timestamp,
            'is_read': False
        }

        # Add parent info for reply
        if message_type == 'reply' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message:
                parent_sender = db.get_employee_by_id(parent_message['sender_id'])
                parent_sender_name = parent_sender['name'] if parent_sender else 'User'
                message_data.update({
                    'parent_content': parent_message['content'],
                    'parent_message_type': parent_message['message_type'],
                    'parent_media_url': parent_message['media_url'],
                    'parent_sender_name': parent_sender_name,
                    'message_header': f"Reply to {parent_sender_name}",
                    'header_icon': 'fa-reply',
                    'parent_filename': parent_message.get('filename')
                })

        # Add parent info for forward
        if message_type == 'forward' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message:
                parent_sender = db.get_employee_by_id(parent_message['sender_id'])
                parent_sender_name = parent_sender['name'] if parent_sender else 'Unknown'
                original_content = parent_message['content']
                cleaned_content = original_content.replace(parent_sender_name, '').strip()

                message_data.update({
                    'content': cleaned_content,
                    'parent_content': original_content,
                    'parent_message_type': parent_message['message_type'],
                    'parent_media_url': parent_message['media_url'],
                    'message_header': f"Forwarded message {parent_sender_name}",
                    'header_icon': 'fa-share',
                    'parent_filename': parent_message.get('filename')
                })

        # Send message to rooms
        emit('new_message', message_data, room=sender_id)
        if sender_id != receiver_id:
            emit('new_message', message_data, room=receiver_id)
            
            # Sorting/activity reordering removed

        # Proactively notify both clients to update last-activity cache for direct list
        try:
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            # For the sender's list, the active peer is the receiver
            emit('update_last_activity', {
                'peer_id': receiver_id,
                'timestamp': now_ms
            }, room=sender_id)
            # For the receiver's list, the active peer is the sender
            if sender_id != receiver_id:
                emit('update_last_activity', {
                    'peer_id': sender_id,
                    'timestamp': now_ms
                }, room=receiver_id)
        except Exception:
            app.logger.exception('Failed to emit update_last_activity for direct message')

        # Send updated unread counts (combined direct + group) to both participants
        try:
            # Receiver combined counts
            r_direct = db.get_user_unread_counts(receiver_id)
            r_group = db.get_user_group_unread_counts(receiver_id)
            r_combined = {**r_group, **r_direct}
            emit('unread_counts_update', r_combined, room=receiver_id)

            # Sender combined counts (their list may change ordering)
            s_direct = db.get_user_unread_counts(sender_id)
            s_group = db.get_user_group_unread_counts(sender_id)
            s_combined = {**s_group, **s_direct}
            emit('unread_counts_update', s_combined, room=sender_id)
        except Exception:
            app.logger.exception('Failed to emit combined unread counts after direct message')

        return {'success': True}

    except Exception as e:
        app.logger.error(f"Error in handle_message: {str(e)}")
        return {'error': 'Internal server error'}

@socketio.on('mark_read')
def handle_mark_read(data):
    message_id = data.get('message_id')
    receiver_id = session.get('user_id') or data.get('receiver_id')
    sender_id = data.get('sender_id')
    
    if message_id and receiver_id:
        db.update_message_status(message_id, True)
        
        # ✅ CRITICAL: Notify sender that their message was read
        emit('message_read', {'message_id': message_id}, room=sender_id)
        
        # Update unread counts for both sender and receiver (combined)
        r_direct = db.get_user_unread_counts(receiver_id)
        r_group = db.get_user_group_unread_counts(receiver_id)
        receiver_combined = {**r_group, **r_direct}

        s_direct = db.get_user_unread_counts(sender_id)
        s_group = db.get_user_group_unread_counts(sender_id)
        sender_combined = {**s_group, **s_direct}
        
        # Emit to both users
        emit('unread_counts_update', receiver_combined, room=receiver_id)
        emit('unread_counts_update', sender_combined, room=sender_id)

# Delivery acknowledgement for direct messages
@socketio.on('message_delivered')
def handle_message_delivered(data):
    try:
        message_id = data.get('message_id')
        sender_id = data.get('sender_id')
        # The caller is the receiver; ensure session is valid
        receiver_id = session.get('user_id')
        if not (message_id and sender_id and receiver_id):
            return
        # Notify original sender that the message reached the receiver's client
        emit('message_delivered', { 'message_id': message_id }, room=sender_id)
    except Exception:
        app.logger.exception('Failed to handle message_delivered')

@app.route('/messages/<sender_id>/<receiver_id>')
def get_messages(sender_id, receiver_id):
    try:
        session_user = (session.get('user_id') or '').strip()
        if session_user != (sender_id or '').strip():
            return jsonify({"error": "Forbidden"}), 403
        limit = request.args.get('limit', 50, type=int)
        messages = db.get_messages(sender_id, receiver_id, limit)
        
        # Mark messages as read when fetched
        unread_ids = [msg['id'] for msg in messages 
                     if msg['receiver_id'] == sender_id and not msg['is_read']]
        
        if unread_ids:
            db.bulk_update_message_status(unread_ids, True)
            # Update unread counts after marking messages as read (combined)
            d_counts = db.get_user_unread_counts(sender_id)
            g_counts = db.get_user_group_unread_counts(sender_id)
            combined = {**g_counts, **d_counts}
            socketio.emit('unread_counts_update', combined, room=sender_id)
        
        return jsonify(messages)
    except Exception as e:
        app.logger.error(f"Error in get_messages: {str(e)}", exc_info=True) 
        return jsonify({"error": "Failed to fetch messages"}), 500

@app.route('/online_users')
def get_online_users():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify([])
    
    # Get users with status, activity, and unread counts (sorting removed)
    users = db.get_users_with_status_and_activity(user_id)
    
    # The database query already includes unread_count, so we don't need to add it here
    return jsonify(users)

# --- CHAT PIN ROUTES ---
@app.route('/chat_pins', methods=['GET'])
@login_required
def get_chat_pins():
    user_id = session.get('user_id')
    pins = db.get_pinned_chats(user_id)
    return jsonify(pins)

@app.route('/chat_pins', methods=['POST'])
@login_required
def set_chat_pin():
    data = request.get_json(silent=True) or {}
    target_type = (data.get('target_type') or '').strip()  # 'user' or 'group'
    target_id = (data.get('target_id') or '').strip()
    pin = bool(data.get('pin', True))
    if target_type not in ('user','group') or not target_id:
        return jsonify({'error': 'Invalid request'}), 400
    user_id = session.get('user_id')
    db.set_chat_pin(user_id, target_type, target_id, pin)
    try:
        # notify this user only; clients of this user will update their own UI
        socketio.emit('chat_pin_updated', {
            'target_type': target_type,
            'target_id': target_id,
            'pin': pin
        }, room=user_id)
    except Exception:
        app.logger.exception('Failed to emit chat_pin_updated')
    return jsonify({'success': True, 'pin': pin})

@app.route('/groups/<int:group_id>/last_activity')
def group_last_activity(group_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    
    activity = db.get_group_last_activity(group_id)
    return jsonify(activity)    

@app.route('/user_status/<user_id>')
def get_user_status(user_id):
    status = db.get_user_status(user_id)
    return jsonify({'status': status})

# --- GROUP CHAT ROUTES & SOCKET EVENTS ---
@app.route('/groups', methods=['GET'])
def get_groups():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    groups = db.get_user_groups(user_id)
    return jsonify(groups)

@app.route('/groups', methods=['POST'])
def create_group():
    data = request.json
    name = data.get('name')
    creator_id = session.get('user_id')
    member_ids = data.get('member_ids', [])
    if not session.get('user_id'):
        return jsonify({'error': 'Unauthorized'}), 401
    if not name:
        return jsonify({'error': 'Missing group name or creator_id'}), 400
    # Normalize and prevent purely whitespace/duplicate names
    name = (name or '').strip()
    try:
        group_id = db.create_group(name, creator_id, member_ids)
    except ValueError as e:
        if str(e) == 'DUPLICATE_GROUP_NAME':
            return jsonify({'error': 'Group name already exists'}), 409
        return jsonify({'error': 'Failed to create group'}), 400
    except Exception:
        # Handle possible UNIQUE constraint race
        return jsonify({'error': 'Group name already exists'}), 409
    # Emit group_created event to all group members
    group_info = db.get_user_groups(creator_id)
    group_data = None
    for g in group_info:
        if g['id'] == group_id:
            group_data = g
            break
    if group_data:
        group_data = convert_datetime(group_data)
        for uid in [creator_id] + member_ids:
            socketio.emit('group_created', group_data, room=uid)
    return jsonify({'group_id': group_id})

@app.route('/groups/<int:group_id>/members', methods=['GET'])
def get_group_members(group_id):
    members = db.get_group_members(group_id)
    return jsonify(convert_datetime(members))

@app.route('/groups/<int:group_id>/members', methods=['POST'])
def add_group_member(group_id):
    data = request.json
    user_id = data.get('user_id')
    admin_id = session.get('user_id')
    if not session.get('user_id'):
        return jsonify({'error': 'Unauthorized'}), 401
    if not user_id:
        return jsonify({'error': 'Missing user_id or admin_id'}), 400
    # Only group creator/admin can add
    if not db.is_group_admin(group_id, admin_id):
        return jsonify({'error': 'Not authorized'}), 403
    db.add_group_member(group_id, user_id)
    return jsonify({'success': True})

@app.route('/groups/<int:group_id>/members', methods=['DELETE'])
def remove_group_member(group_id):
    data = request.json
    user_id = data.get('user_id')
    admin_id = session.get('user_id')
    if not session.get('user_id'):
        return jsonify({'error': 'Unauthorized'}), 401
    if not user_id:
        return jsonify({'error': 'Missing user_id or admin_id'}), 400
    if not db.is_group_admin(group_id, admin_id):
        return jsonify({'error': 'Not authorized'}), 403
    db.remove_group_member(group_id, user_id)
    return jsonify({'success': True})

@app.route('/groups/<int:group_id>/messages', methods=['GET'])
def get_group_messages(group_id):
    limit = request.args.get('limit', 50, type=int)
    messages = db.get_group_messages(group_id, limit)
    return jsonify(convert_datetime(messages))

@app.route('/messages/<int:message_id>/seen', methods=['GET'])
def get_message_seen_users(message_id):
    users = db.get_message_seen_users(message_id)
    return jsonify(users) 

# --- SOCKET EVENTS FOR GROUP CHAT ---
@socketio.on('join_group')
def handle_join_group(data):
    group_id = data.get('group_id')
    user_id = session.get('user_id')
    if group_id and user_id:
        join_room(f'group_{group_id}')

@socketio.on('leave_group')
def handle_leave_group(data):
    group_id = data.get('group_id')
    user_id = session.get('user_id')
    if group_id and user_id:
        leave_room(f'group_{group_id}')

@socketio.on('send_group_message')
def handle_send_group_message(data):
    try:
        sender_id = session.get('user_id')
        if not sender_id:
            return {'error': 'Unauthorized'}
        group_id = data.get('group_id')
        content = data.get('content')
        message_type = data.get('type', 'text')
        parent_message_id = data.get('parent_message_id')
        media_url = data.get('media_url')
        media_type = data.get('media_type')
        file_size = None
        filename = data.get('filename')
        
        # ✅ Log only metadata, not full base64 payload
        app.logger.info(
        "[Group] Received message in group %s from %s | type=%s | filename=%s | has_media=%s",
        group_id,
        sender_id,
        message_type,
        filename,
        bool(media_url)
        )

        if message_type == 'text':
            content = emoji.emojize(content)
        if message_type in ('image', 'file') and media_url:
            is_valid, result = save_uploaded_file(media_url, filename or "attachment")
            if not is_valid:
                return {'error': result}
            media_url = result
            file_path = os.path.join('static', media_url)
            if os.path.exists(file_path):
                file_size = os.path.getsize(file_path)
            else:
                return {'error': 'Failed to save file'}
            media_type = 'image' if message_type == 'image' else 'file'
            if not filename and media_url:
                filename = os.path.basename(media_url)

        # Handle forwarded media
        if message_type == 'forward' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message and parent_message.get('media_url'):
                media_url = parent_message['media_url']
                media_type = parent_message.get('media_type') or (
                    'image' if str(media_url).lower().endswith(('.jpg', '.jpeg', '.png')) else 'file'
                )
                file_size = parent_message.get('file_size')
                if not filename:
                    filename = parent_message.get('filename') or os.path.basename(media_url)

        # Save message to database (only once)
        message_id = db.save_group_message(
            sender_id=sender_id,
            group_id=group_id,
            content=content,
            message_type=message_type,
            parent_message_id=parent_message_id,
            media_url=media_url,
            media_type=media_type if media_type else (message_type if message_type == 'image' else None),
            file_size=file_size,
            filename=filename
        )
        if not message_id:
            return {'error': 'Failed to save message'}
        
        sender = db.get_employee_by_id(sender_id)
        current_utc = datetime.now(timezone.utc)
        timestamp = current_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        
        message_data = {
            'id': message_id,
            'sender_id': sender_id,
            'sender_name': sender['name'] if sender else 'Unknown',
            'group_id': group_id,
            'content': content,
            'type': message_type,
            'parent_message_id': parent_message_id,
            'media_url': media_url,
            'media_type': media_type,
            'filename': filename,
            'file_size': file_size,
            'timestamp': timestamp,
            'is_read': False
        }
        
        if message_type == 'reply' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message:
                parent_sender = db.get_employee_by_id(parent_message['sender_id'])
                parent_sender_name = parent_sender['name'] if parent_sender else 'User'
                message_data.update({
                    'parent_content': parent_message['content'],
                    'parent_message_type': parent_message['message_type'],
                    'parent_media_url': parent_message['media_url'],
                    'parent_sender_name': parent_sender_name,
                    'message_header': f"Reply to {parent_sender_name}",
                    'header_icon': 'fa-reply',
                    'parent_filename': parent_message.get('filename')
                })

        if message_type == 'forward' and parent_message_id:
            parent_message = db.get_message_by_id(parent_message_id)
            if parent_message:
                # Get original sender
                parent_sender = db.get_employee_by_id(parent_message['sender_id'])
                parent_sender_name = parent_sender['name'] if parent_sender else 'Unknown'

                # Remove sender name from the beginning of the content if present
                original_content = parent_message['content']
                cleaned_content = original_content.replace(parent_sender_name, '').strip()
                
                message_data.update({
                    'content': cleaned_content,
                    'parent_content': original_content,
                    'parent_message_type': parent_message['message_type'],
                    'parent_media_url': parent_message['media_url'],
                    'message_header': f"Forwarded message {parent_sender_name}",
                    'header_icon': 'fa-share',
                    'parent_filename': parent_message.get('filename')
                })
                                
        # Emit to group room only once
        emit('new_group_message', message_data, room=f'group_{group_id}')

        # Add this section with proper indentation (4 spaces)
        current_time = int(datetime.now(timezone.utc).timestamp() * 1000)
        members = db.get_group_members(group_id)
        for member in members:
            socketio.emit('update_group_activity', {
                'group_id': group_id,
                'timestamp': current_time
            }, room=member['user_id'])
        
        # Update unread counts for all members (combined), including sender to keep UI in sync
        members = db.get_group_members(group_id)
        for member in members:
            try:
                uid = member['user_id']
                d_counts = db.get_user_unread_counts(uid)
                g_counts = db.get_user_group_unread_counts(uid)
                combined_counts = {**g_counts, **d_counts}
                emit('unread_counts_update', combined_counts, room=uid)
            except Exception:
                app.logger.exception('Failed to emit combined unread counts after group message')

        return {'success': True}
    except Exception as e:
        app.logger.error(f"Error in handle_send_group_message: {str(e)}")
        return {'error': 'Internal server error'}

@socketio.on('mark_group_message_seen')
def handle_mark_group_message_seen(data):
    message_id = data.get('message_id')
    user_id = session.get('user_id')
    group_id = data.get('group_id')
    
    if message_id and user_id and group_id:
        db.mark_message_seen(message_id, user_id)
        
        unread_counts = db.get_user_group_unread_counts(user_id)
        direct_unread_counts = db.get_user_unread_counts(user_id)
        combined_counts = {**direct_unread_counts, **unread_counts}
        
        emit('unread_counts_update', combined_counts, room=user_id)
        
        seen_users = db.get_message_seen_users(message_id)
        seen_users = convert_datetime(seen_users)
        emit('group_message_seen_update', {
            'message_id': message_id,
            'seen_users': seen_users
        }, room=f'group_{group_id}')

@app.route('/messages/pin', methods=['POST'])
def pin_message():
    data = request.json
    message_id = data.get('message_id')
    pin = data.get('pin', True)
    if not message_id:
        return jsonify({'error': 'Missing message_id'}), 400
    db.pin_message(message_id, pin)
    # Broadcast pin state change so all clients update
    try:
        # Emit only to the two participants of the direct conversation
        message = db.get_message_by_id(message_id)
        if message:
            sender_id = message.get('sender_id')
            receiver_id = message.get('receiver_id')
            if sender_id:
                socketio.emit('message_pinned', {'message_id': message_id, 'pinned': pin}, room=sender_id)
            if receiver_id and receiver_id != sender_id:
                socketio.emit('message_pinned', {'message_id': message_id, 'pinned': pin}, room=receiver_id)
    except Exception:
        app.logger.exception('Failed to broadcast message_pinned')
    return jsonify({'success': True, 'pinned': pin})

@app.route('/messages/pinned', methods=['GET'])
def get_pinned_messages():
    sender_id = request.args.get('sender_id')
    receiver_id = request.args.get('receiver_id')
    group_id = request.args.get('group_id')
    messages = db.get_pinned_messages(sender_id, receiver_id, group_id)
    return jsonify(messages)

@app.route('/groups/<int:group_id>/messages/pin', methods=['POST'])
def pin_group_message(group_id):
    data = request.json
    message_id = data.get('message_id')
    pin = data.get('pin', True)
    if not message_id:
        return jsonify({'error': 'Missing message_id'}), 400
    db.pin_message(message_id, pin)
    # Broadcast to group room and to all clients for consistency
    try:
        socketio.emit('group_message_pinned', {'message_id': message_id, 'pinned': pin, 'group_id': group_id}, room=f'group_{group_id}')
    except Exception:
        app.logger.exception('Failed to broadcast group_message_pinned')
    return jsonify({'success': True, 'pinned': pin})

@app.route('/messages/search', methods=['GET'])
def search_messages():
    query = request.args.get('query')
    sender_id = request.args.get('sender_id')
    receiver_id = request.args.get('receiver_id')
    group_id = request.args.get('group_id')
    limit = request.args.get('limit', 50, type=int)
    if not query:
        return jsonify([])
    messages = db.search_messages(query, sender_id, receiver_id, group_id, limit)
    return jsonify(messages)

@socketio.on('pin_message')
def handle_pin_message(data):
    message_id = data.get('message_id')
    pin = data.get('pin', True)
    db.pin_message(message_id, pin)
    # Emit only to the two participants of the direct conversation
    try:
        message = db.get_message_by_id(message_id)
        if message:
            sender_id = message.get('sender_id')
            receiver_id = message.get('receiver_id')
            if sender_id:
                socketio.emit('message_pinned', {'message_id': message_id, 'pinned': pin}, room=sender_id)
            if receiver_id and receiver_id != sender_id:
                socketio.emit('message_pinned', {'message_id': message_id, 'pinned': pin}, room=receiver_id)
    except Exception:
        app.logger.exception('Failed to emit message_pinned for direct message')

if __name__ == '__main__': 
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', '8000'))
    socketio.run(app, debug=debug, host=host, port=port)
