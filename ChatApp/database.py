import pymysql
from datetime import datetime
import os
from typing import Optional, Dict, Any
from werkzeug.security import check_password_hash
import hashlib
from contextlib import contextmanager

try:
    # Prefer robust, thread-safe pooling
    from dbutils.pooled_db import PooledDB  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    PooledDB = None  # Fallback without hard dependency

try:
    import bcrypt
except ImportError:
    bcrypt = None  # fallback if bcrypt is not installed

class Database:
    def __init__(self):
        # Single database: all tables live in chat_db
        self.db_config = {
            'host': '',
            'user': '',
            'password': '',
            'database': '',
            'charset': '',
            'autocommit': False,
        }

        # Initialize a shared connection pool for all operations
        self._pool = None
        if PooledDB is not None:
            try:
                # Tuneables: allow ~200 concurrent clients; most queries are short-lived
                self._pool = PooledDB(
                    creator=pymysql,
                    maxconnections=100,      # hard cap
                    mincached=5,              # warm pool
                    maxcached=50,             # cache up to 50 idle
                    blocking=True,            # wait if exhausted
                    maxusage=None,            # unlimited reuse
                    setsession=['SET SESSION sql_mode="STRICT_TRANS_TABLES"'],
                    ping=1,                   # 1 = ping on checkout
                    **self.db_config,
                )
            except Exception:
                self._pool = None  # Fall back to per-call connections

        # Backwards compatible proxies so existing code using
        # `with self.chat_conn.cursor(...) as cursor:` keeps working.
        self.chat_conn = _PooledConnectionProxy(self._pool, self.db_config)
        self.auth_conn = self.chat_conn
        self.ops_conn = self.chat_conn

        # Detect which ID column is present in ot_users (emp_id vs employee_id)
        self.auth_id_col = self._detect_auth_id_column()

    def _detect_auth_id_column(self) -> str:
        try:
            with self.auth_conn.cursor() as cursor:
                cursor.execute("SHOW COLUMNS FROM ot_users LIKE 'emp_id'")
                if cursor.fetchone():
                    return 'emp_id'
                cursor.execute("SHOW COLUMNS FROM ot_users LIKE 'employee_id'")
                if cursor.fetchone():
                    return 'employee_id'
        except Exception:
            pass
        return 'emp_id'

    def create_tables(self):
        with self.chat_conn.cursor() as cursor:
            # Create messages table (add group_id)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    sender_id VARCHAR(20) NOT NULL,
                    receiver_id VARCHAR(20),
                    group_id INT NULL,
                    content TEXT NOT NULL,
                    message_type ENUM('text', 'image', 'file', 'reply', 'forward') NOT NULL,
                    parent_message_id INT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_read BOOLEAN DEFAULT FALSE,
                    media_url VARCHAR(255) NULL,
                    media_type VARCHAR(50) NULL,
                    file_size INT NULL,
                    filename VARCHAR(255) NULL,
                    pinned BOOLEAN DEFAULT FALSE
                )
            """)
            # Create groups table (quote with backticks)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS `groups` (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    creator_id VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Ensure unique group names (idempotent; ignore if already exists)
            try:
                cursor.execute("""
                    ALTER TABLE `groups` ADD UNIQUE KEY `uq_groups_name` (`name`)
                """)
            except Exception:
                # Unique key likely already exists
                pass
            # Create group_members table (quote with backticks)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS `group_members` (
                    group_id INT NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    is_admin BOOLEAN DEFAULT FALSE,
                    PRIMARY KEY (group_id, user_id),
                    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
                )
            """)
            # Create message_seen table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS message_seen (
                    message_id INT NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (message_id, user_id),
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
                )
            """)
            
            # Create online_status table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS online_status (
                    user_id VARCHAR(20) PRIMARY KEY,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_online BOOLEAN DEFAULT FALSE
                )
            """)
            # Per-user pinned chats (direct or group)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chat_pins (
                    user_id VARCHAR(20) NOT NULL,
                    target_type ENUM('user','group') NOT NULL,
                    target_id VARCHAR(64) NOT NULL,
                    pinned BOOLEAN NOT NULL DEFAULT TRUE,
                    pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, target_type, target_id)
                )
            """)
        self.chat_conn.commit()

        # Ensure ot_users table exists in chat_db (idempotent)
        try:
            with self.auth_conn.cursor() as cursor:
                create_users_table_query = """
                    CREATE TABLE IF NOT EXISTS ot_users (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        emp_id VARCHAR(10) NOT NULL UNIQUE,
                        name VARCHAR(100) NOT NULL,
                        password VARCHAR(255) NOT NULL,
                        status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
                        session_id VARCHAR(255),
                        login_time DATETIME NULL,
                        logout_time DATETIME NULL
                    ) ENGINE=InnoDB;
                """
                cursor.execute(create_users_table_query)
            self.auth_conn.commit()
        except Exception:
            pass

    # --- AUTH METHODS (ardurtechnology.ot_users) ---
    def get_user_by_emp_id(self, emp_id: str) -> Optional[Dict[str, Any]]:
        with self.auth_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            # Select * to be resilient to column name differences
            sql = f"SELECT * FROM ot_users WHERE {self.auth_id_col} = %s LIMIT 1"
            cursor.execute(sql, (emp_id,))
            row = cursor.fetchone()
            if not row:
                return None

            # Normalize to a consistent user dict
            normalized: Dict[str, Any] = {
                'id': row.get('id'),
                'emp_id': row.get(self.auth_id_col) or row.get('emp_id') or row.get('employee_id') or emp_id,
                'name': row.get('name') or row.get('full_name') or row.get('user_name') or '',
                'password': row.get('password') or row.get('pwd') or row.get('pass') or row.get('user_password') or '',
                'status': row.get('status') or row.get('active') or row.get('is_active') or '',
                'session_id': row.get('session_id'),
                'login_time': row.get('login_time'),
                'logout_time': row.get('logout_time')
            }

            # Fallback: derive name from employees table if missing
            if not normalized['name']:
                try:
                    with self.ops_conn.cursor(pymysql.cursors.DictCursor) as emp_cursor:
                        emp_cursor.execute("SELECT name FROM ot_employees WHERE employee_id = %s", (normalized['emp_id'],))
                        emp = emp_cursor.fetchone()
                        if emp and emp.get('name'):
                            normalized['name'] = emp['name']
                except Exception:
                    pass

            return normalized

    def verify_credentials(self, emp_id: str, password: str) -> Optional[Dict[str, Any]]:
        """
        Return user dict if credentials valid and active, else None.
        Supports PBKDF2 (werkzeug), bcrypt, MySQL native hash, MD5/SHA1/SHA256, and plain text.
        """
        user = self.get_user_by_emp_id(emp_id)
        if not user:
            return None

        # Treat status permissively: consider active unless clearly inactive
        status = (user.get('status') or '').strip().lower()
        inactive_markers = {'inactive', 'disabled', 'blocked', '0', 'n', 'false'}
        if status in inactive_markers:
            return None

        stored_raw = user.get('password')
        if stored_raw is None:
            return None
        stored = str(stored_raw).strip()

        # 1) werkzeug pbkdf2/bcrypt style hashes
        try:
            if check_password_hash(stored, password):
                return user
        except Exception:
            pass

        # 2) bcrypt ($2a/$2b/$2y$...)
        if bcrypt and stored.startswith(('$2a$', '$2b$', '$2y$')):
            try:
                if bcrypt.checkpw(password.encode('utf-8'), stored.encode('utf-8')):
                    return user
            except Exception:
                pass

        # 3) MySQL native hash: "*" + SHA1(SHA1(password)) in uppercase hex
        if stored.startswith('*') and len(stored) == 41:
            try:
                mysql_hash = '*' + hashlib.sha1(hashlib.sha1(password.encode('utf-8')).digest()).hexdigest().upper()
                if mysql_hash == stored.upper():
                    return user
            except Exception:
                pass

        # 4) Legacy unsalted hashes in hex: MD5/SHA1/SHA256
        hex_candidate = stored.lower()
        if all(c in '0123456789abcdef*' for c in hex_candidate):
            try:
                if len(hex_candidate) == 32:  # MD5
                    if hashlib.md5(password.encode('utf-8')).hexdigest() == hex_candidate:
                        return user
                elif len(hex_candidate) == 40:  # SHA1
                    if hashlib.sha1(password.encode('utf-8')).hexdigest() == hex_candidate:
                        return user
                elif len(hex_candidate) == 64:  # SHA256
                    if hashlib.sha256(password.encode('utf-8')).hexdigest() == hex_candidate:
                        return user
            except Exception:
                pass

        # 5) Plain text (trimmed) — only if not a recognized hash
        if not stored.startswith(('$2a$', '$2b$', '$2y$', '*')) and stored == password:
            return user

        return None

    def record_login(self, emp_id: str, session_id: Optional[str]) -> None:
        with self.auth_conn.cursor() as cursor:
            sql = f"""
                UPDATE ot_users
                SET session_id = %s, login_time = NOW(), logout_time = NULL
                WHERE {self.auth_id_col} = %s
            """
            cursor.execute(sql, (session_id, emp_id))
        self.auth_conn.commit()

    def record_logout(self, emp_id: str) -> None:
        with self.auth_conn.cursor() as cursor:
            sql = f"""
                UPDATE ot_users
                SET logout_time = NOW(), session_id = NULL
                WHERE {self.auth_id_col} = %s
            """
            cursor.execute(sql, (emp_id,))
        self.auth_conn.commit()

    def get_active_employees(self):
        with self.ops_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT employee_id, name, role 
                FROM ot_employees 
                WHERE status = 'Active'
            """
            cursor.execute(sql)
            return cursor.fetchall()

    def save_message(self, sender_id, receiver_id, content, message_type='text', parent_message_id=None, media_url=None, media_type=None, file_size=None, filename=None):
        with self.chat_conn.cursor() as cursor:
            # Always set group_id to NULL for direct messages
            sql = """INSERT INTO messages \
                    (sender_id, receiver_id, group_id, content, message_type, parent_message_id, media_url, media_type, file_size, filename) \
                    VALUES (%s, %s, NULL, %s, %s, %s, %s, %s, %s, %s)"""
            cursor.execute(sql, (sender_id, receiver_id, content, message_type, parent_message_id, media_url, media_type, file_size, filename))
            self.chat_conn.commit()
            return cursor.lastrowid

    def get_messages(self, sender_id, receiver_id, limit=50):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            # Only fetch direct messages (group_id IS NULL)
            sql = """SELECT 
                    m.id, 
                    m.sender_id, 
                    m.receiver_id, 
                    m.content, 
                    m.message_type, 
                    m.parent_message_id, 
                    CONVERT_TZ(m.created_at, @@session.time_zone, '+00:00') as created_at,
                    m.is_read, 
                    m.media_url,
                    m.media_type,
                    m.file_size,
                    m.filename,
                    m.pinned,
                    p.content as parent_content, 
                    p.sender_id as parent_sender_id,
                    p.message_type as parent_message_type, 
                    p.media_url as parent_media_url,
                    COALESCE(e.name, 'Unknown User') as parent_sender_name,
                    CASE 
                        WHEN m.message_type = 'forward' THEN CONCAT('Forwarded message ', COALESCE(e.name, 'Unknown User'))
                        WHEN m.message_type = 'reply' THEN CONCAT('Reply to ', COALESCE(e.name, 'Unknown User'))
                        ELSE NULL
                    END as message_header,

                    CASE 
                        WHEN m.message_type = 'reply' THEN 'fa-reply'
                        WHEN m.message_type = 'forward' THEN 'fa-share'
                        ELSE NULL
                    END as header_icon,
                    e2.name as sender_name
                    FROM messages m
                    LEFT JOIN messages p ON m.parent_message_id = p.id
                    LEFT JOIN ot_employees e ON p.sender_id = e.employee_id
                    LEFT JOIN ot_employees e2 ON m.sender_id = e2.employee_id
                    WHERE ((m.sender_id = %s AND m.receiver_id = %s) OR (m.sender_id = %s AND m.receiver_id = %s))
                    AND m.group_id IS NULL
                    ORDER BY m.created_at DESC LIMIT %s"""
            
            cursor.execute(sql, (sender_id, receiver_id, receiver_id, sender_id, limit))
            messages = cursor.fetchall()
            
            for message in messages:
                if message['created_at']:
                    message['created_at'] = message['created_at'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                
                if message['media_url'] and not message['media_url'].startswith('/static/'):
                    rel = str(message['media_url'])
                    base = os.path.basename(rel)
                    if 'uploads/files/' in rel:
                        message['media_url'] = f"/static/uploads/files/{base}"
                    else:
                        message['media_url'] = f"/static/uploads/images/{base}"

                if message['parent_media_url'] and not message['parent_media_url'].startswith('/static/'):
                    prel = str(message['parent_media_url'])
                    pbase = os.path.basename(prel)
                    if 'uploads/files/' in prel:
                        message['parent_media_url'] = f"/static/uploads/files/{pbase}"
                    else:
                        message['parent_media_url'] = f"/static/uploads/images/{pbase}"

                # Fallback if parent details are missing
                if message['message_type'] in ['reply', 'forward'] and message['parent_message_id']:
                    if not message['parent_content'] and not message['parent_media_url']:
                        message['parent_content'] = 'Original message not available'
                        message['parent_message_type'] = 'text'
                        message['parent_media_url'] = None

                    if not message['parent_sender_name'] or message['parent_sender_name'] == 'Unknown User':
                        parent_message = self.get_message_by_id(message['parent_message_id'])
                        if parent_message:
                            message['parent_content'] = parent_message['content']
                            message['parent_sender_name'] = parent_message['sender_name']
                            message['parent_message_type'] = parent_message['message_type']
                            message['parent_media_url'] = parent_message['media_url']
                            message['message_header'] = f"Reply to {parent_message['sender_name']}"

                # Derive filename from path if missing
                if (not message.get('filename')) and message.get('media_url'):
                    path_base = os.path.basename(str(message['media_url']))
                    # If hash.ext pattern, leave as-is but better to show ext only
                    message['filename'] = path_base

                # ✅ Fix for forwarded message: clean parent content
                if message['message_type'] == 'forward':
                    parent_sender_name = message.get('parent_sender_name', '')
                    parent_content = message.get('parent_content', '')
                    if parent_sender_name and parent_content:
                        cleaned_content = parent_content.replace(parent_sender_name, '', 1).strip()
                        message['content'] = cleaned_content

            return messages

    def update_message_status(self, message_id, is_read=True):
        with self.chat_conn.cursor() as cursor:
            sql = "UPDATE messages SET is_read = %s WHERE id = %s"
            cursor.execute(sql, (is_read, message_id))
            self.chat_conn.commit()

    def update_user_status(self, user_id, is_online=True):
        with self.chat_conn.cursor() as cursor:
            sql = """INSERT INTO online_status (user_id, is_online, last_seen) 
                    VALUES (%s, %s, NOW())
                    ON DUPLICATE KEY UPDATE 
                    is_online = VALUES(is_online),
                    last_seen = VALUES(last_seen)"""
            cursor.execute(sql, (user_id, is_online))
            self.chat_conn.commit()

    def get_online_users(self):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """SELECT o.user_id, o.is_online, o.last_seen, e.name
                    FROM online_status o
                    JOIN ot_employees e ON o.user_id = e.employee_id
                    WHERE o.is_online = TRUE OR 
                    o.last_seen >= NOW() - INTERVAL 5 MINUTE"""
            cursor.execute(sql)
            return cursor.fetchall()

    def get_users_with_status_and_activity(self, current_user_id: str):
        """Return all active employees with presence and last direct chat message time vs current user.

        Note: No ORDER BY here; client will sort by last_direct_msg desc then name.
        """
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT 
                    e.employee_id AS user_id,
                    e.name,
                    e.role,
                    COALESCE(os.is_online, FALSE) AS is_online,
                    os.last_seen,
                    (
                        SELECT MAX(m.created_at)
                        FROM messages m
                        WHERE m.group_id IS NULL
                        AND ((m.sender_id = e.employee_id AND m.receiver_id = %s)
                             OR (m.sender_id = %s AND m.receiver_id = e.employee_id))
                    ) AS last_direct_msg,
                    (
                        SELECT COUNT(*)
                        FROM messages m
                        WHERE m.receiver_id = %s 
                        AND m.sender_id = e.employee_id
                        AND m.is_read = FALSE
                        AND m.group_id IS NULL
                    ) AS unread_count
                FROM ot_employees e
                LEFT JOIN online_status os ON os.user_id = e.employee_id
                WHERE e.status = 'Active'
            """
            cursor.execute(sql, (current_user_id, current_user_id, current_user_id))
            rows = cursor.fetchall()
            for row in rows:
                if row.get('last_seen'):
                    # Convert datetime to string if it's a datetime object
                    if isinstance(row['last_seen'], datetime):
                        row['last_seen'] = row['last_seen'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')

                if row.get('last_direct_msg'):
                    # Convert datetime to string if it's a datetime object
                    if isinstance(row['last_direct_msg'], datetime):
                        row['last_direct_msg'] = row['last_direct_msg'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                    # If it's already a string, leave it as is
            return rows

    def get_user_groups(self, user_id):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("""
                SELECT 
                    g.id, 
                    g.name, 
                    g.creator_id, 
                    g.created_at,
                    (
                        SELECT MAX(m.created_at)
                        FROM messages m
                        WHERE m.group_id = g.id
                    ) as last_activity,
                    (
                        SELECT COUNT(*)
                        FROM messages m
                        JOIN group_members gm ON m.group_id = gm.group_id
                        LEFT JOIN message_seen ms ON m.id = ms.message_id AND ms.user_id = %s
                        WHERE gm.user_id = %s
                        AND ms.message_id IS NULL
                        AND m.sender_id != %s
                        AND m.group_id = g.id
                    ) as unread_count
                FROM `groups` g
                JOIN `group_members` gm ON g.id = gm.group_id
                WHERE gm.user_id = %s
            """, (user_id, user_id, user_id, user_id))
            results = cursor.fetchall()
            for row in results:
                if 'message_type' in row and 'type' not in row:
                    row['type'] = row['message_type']
                if 'created_at' in row and row['created_at']:
                    row['created_at'] = row['created_at'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                if 'last_activity' in row and row['last_activity']:
                    row['last_activity'] = row['last_activity'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            return results

    def get_group_last_activity(self, group_id):
        """Get the timestamp of the most recent message in a group"""
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT MAX(created_at) as last_activity
                FROM messages
                WHERE group_id = %s
            """
            cursor.execute(sql, (group_id,))
            result = cursor.fetchone()
            return result        

    def get_employee_by_id(self, employee_id):
        with self.ops_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = "SELECT * FROM ot_employees WHERE employee_id = %s"
            cursor.execute(sql, (employee_id,))
            return cursor.fetchone()

    def get_unread_count(self, receiver_id, sender_id):
        with self.chat_conn.cursor() as cursor:
            sql = """SELECT COUNT(*) as count 
                    FROM messages 
                    WHERE receiver_id = %s 
                    AND sender_id = %s 
                    AND is_read = FALSE"""
            cursor.execute(sql, (receiver_id, sender_id))
            result = cursor.fetchone()
            return result[0] if result else 0

    # Update get_user_unread_counts to properly filter read messages
    def get_user_unread_counts(self, user_id):
        """Get unread counts for direct messages"""
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT sender_id, COUNT(*) as unread_count
                FROM messages
                WHERE receiver_id = %s 
                AND is_read = FALSE
                AND group_id IS NULL
                GROUP BY sender_id
            """
            cursor.execute(sql, (user_id,))
            return {row['sender_id']: row['unread_count'] for row in cursor.fetchall()}

    def get_user_group_unread_counts(self, user_id):
        """Get unread counts for group messages"""
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT m.group_id, COUNT(*) as unread_count
                FROM messages m
                JOIN group_members gm ON m.group_id = gm.group_id
                LEFT JOIN message_seen ms ON m.id = ms.message_id AND ms.user_id = %s
                WHERE gm.user_id = %s
                AND ms.message_id IS NULL
                AND m.sender_id != %s
                GROUP BY m.group_id
            """
            cursor.execute(sql, (user_id, user_id, user_id))
            results = cursor.fetchall()
            return {f"group_{row['group_id']}": row['unread_count'] for row in results} 

    def get_user_status(self, user_id):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT is_online, last_seen
                FROM online_status
                WHERE user_id = %s
            """
            cursor.execute(sql, (user_id,))
            result = cursor.fetchone()
            if result:
                if result['is_online']:
                    return 'online'
                # Convert last_seen to timestamp for comparison
                last_seen_ts = result['last_seen'].timestamp()
                if (datetime.now().timestamp() - last_seen_ts) <= 300:  # 5 minutes
                    return 'away'
                return 'offline'
            return 'offline'

    def get_message_by_id(self, message_id):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """SELECT 
                    m.id, 
                    m.sender_id, 
                    m.receiver_id, 
                    m.content, 
                    m.message_type, 
                    m.parent_message_id, 
                    CONVERT_TZ(m.created_at, @@session.time_zone, '+00:00') as created_at,
                    m.is_read, 
                    m.media_url,
                    m.media_type,
                    m.file_size,
                    m.filename,
                    m.pinned,
                    e.name as sender_name
                    FROM messages m
                    LEFT JOIN ot_employees e ON m.sender_id = e.employee_id
                    WHERE m.id = %s"""
            cursor.execute(sql, (message_id,))
            message = cursor.fetchone()
            
            if message and message['created_at']:
                message['created_at'] = message['created_at'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                
            if message and message['media_url'] and not message['media_url'].startswith('/static/'):
                rel = str(message['media_url'])
                base = os.path.basename(rel)
                if 'uploads/files/' in rel:
                    message['media_url'] = f"uploads/files/{base}"
                else:
                    message['media_url'] = f"uploads/images/{base}"
            if message and not message.get('filename') and message.get('media_url'):
                message['filename'] = os.path.basename(str(message['media_url']))
                
            return message

    # --- CHAT PIN METHODS ---
    def set_chat_pin(self, user_id: str, target_type: str, target_id: str, pin: bool) -> None:
        if target_type not in ('user', 'group'):
            return
        with self.chat_conn.cursor() as cursor:
            if pin:
                cursor.execute(
                    """
                    INSERT INTO chat_pins (user_id, target_type, target_id, pinned, pinned_at)
                    VALUES (%s, %s, %s, TRUE, NOW())
                    ON DUPLICATE KEY UPDATE pinned = VALUES(pinned), pinned_at = VALUES(pinned_at)
                    """,
                    (user_id, target_type, str(target_id))
                )
            else:
                # Either set pinned=false or delete; choose to delete for simplicity
                cursor.execute(
                    """DELETE FROM chat_pins WHERE user_id = %s AND target_type = %s AND target_id = %s""",
                    (user_id, target_type, str(target_id))
                )
        self.chat_conn.commit()

    def get_pinned_chats(self, user_id: str):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(
                """
                SELECT target_type, target_id
                FROM chat_pins
                WHERE user_id = %s AND pinned = TRUE
                """,
                (user_id,)
            )
            users = []
            groups = []
            for row in cursor.fetchall():
                if row['target_type'] == 'user':
                    users.append(row['target_id'])
                elif row['target_type'] == 'group':
                    try:
                        groups.append(int(row['target_id']))
                    except Exception:
                        # If stored as string, keep string
                        groups.append(row['target_id'])
            return { 'users': users, 'groups': groups }

    # GROUP MANAGEMENT METHODS
    def group_name_exists(self, name: str) -> bool:
        with self.chat_conn.cursor() as cursor:
            try:
                cursor.execute("SELECT 1 FROM `groups` WHERE name = %s LIMIT 1", (name,))
                return cursor.fetchone() is not None
            except Exception:
                return False

    def create_group(self, name, creator_id, member_ids):
        with self.chat_conn.cursor() as cursor:
            # Pre-check for duplicate to give friendly error before hitting UNIQUE
            cursor.execute("SELECT id FROM `groups` WHERE name = %s LIMIT 1", (name,))
            row = cursor.fetchone()
            if row:
                raise ValueError("DUPLICATE_GROUP_NAME")

            cursor.execute("INSERT INTO `groups` (name, creator_id) VALUES (%s, %s)", (name, creator_id))
            group_id = cursor.lastrowid
            # Add creator as admin
            cursor.execute("INSERT INTO `group_members` (group_id, user_id, is_admin) VALUES (%s, %s, TRUE)", (group_id, creator_id))
            # Add other members
            for user_id in member_ids:
                if user_id != creator_id:
                    cursor.execute("INSERT INTO `group_members` (group_id, user_id) VALUES (%s, %s)", (group_id, user_id))
            self.chat_conn.commit()
            return group_id

    def get_group_members(self, group_id):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("""
                SELECT gm.user_id, gm.is_admin, e.name, e.role
                FROM `group_members` gm
                LEFT JOIN ot_employees e ON gm.user_id = e.employee_id
                WHERE gm.group_id = %s
            """, (group_id,))
            results = cursor.fetchall()
            for row in results:
                if 'message_type' in row and 'type' not in row:
                    row['type'] = row['message_type']
            return results

    def add_group_member(self, group_id, user_id, is_admin=False):
        with self.chat_conn.cursor() as cursor:
            cursor.execute("INSERT IGNORE INTO `group_members` (group_id, user_id, is_admin) VALUES (%s, %s, %s)", (group_id, user_id, is_admin))
            self.chat_conn.commit()

    def remove_group_member(self, group_id, user_id):
        with self.chat_conn.cursor() as cursor:
            cursor.execute("DELETE FROM `group_members` WHERE group_id = %s AND user_id = %s", (group_id, user_id))
            self.chat_conn.commit()

    def is_group_admin(self, group_id, user_id):
        with self.chat_conn.cursor() as cursor:
            cursor.execute("SELECT is_admin FROM `group_members` WHERE group_id = %s AND user_id = %s", (group_id, user_id))
            result = cursor.fetchone()
            return result and result[0]

    # GROUP MESSAGE METHODS
    def save_group_message(self, sender_id, group_id, content, message_type='text', parent_message_id=None, media_url=None, media_type=None, file_size=None, filename=None):
        with self.chat_conn.cursor() as cursor:
            # Always set receiver_id to NULL for group messages
            sql = """INSERT INTO messages 
                    (sender_id, receiver_id, group_id, content, message_type, parent_message_id, media_url, media_type, file_size, filename) 
                    VALUES (%s, NULL, %s, %s, %s, %s, %s, %s, %s, %s)"""
            cursor.execute(sql, (sender_id, group_id, content, message_type, parent_message_id, media_url, media_type, file_size, filename))
            self.chat_conn.commit()
            return cursor.lastrowid

    def get_group_messages(self, group_id, limit=50):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """SELECT 
                    m.id, 
                    m.sender_id, 
                    m.content, 
                    m.message_type, 
                    m.parent_message_id, 
                    CONVERT_TZ(m.created_at, @@session.time_zone, '+00:00') as created_at,
                    m.is_read, 
                    m.media_url,
                    m.media_type,
                    m.file_size,
                    m.filename,
                    m.pinned,
                    p.content as parent_content, 
                    p.sender_id as parent_sender_id,
                    p.message_type as parent_message_type, 
                    p.media_url as parent_media_url,
                    COALESCE(e.name, 'Unknown User') as parent_sender_name,
                    CASE 
                        WHEN m.message_type = 'forward' THEN CONCAT('Forwarded message ', COALESCE(e.name, 'Unknown User'))
                        WHEN m.message_type = 'reply' THEN CONCAT('Reply to ', COALESCE(e.name, 'Unknown User'))
                        ELSE NULL
                    END as message_header,

                    CASE 
                        WHEN m.message_type = 'reply' THEN 'fa-reply'
                        WHEN m.message_type = 'forward' THEN 'fa-share'
                        ELSE NULL
                    END as header_icon,
                    e2.name as sender_name
                    FROM messages m
                    LEFT JOIN messages p ON m.parent_message_id = p.id
                    LEFT JOIN ot_employees e ON p.sender_id = e.employee_id
                    LEFT JOIN ot_employees e2 ON m.sender_id = e2.employee_id
                    WHERE m.group_id = %s AND m.receiver_id IS NULL
                    ORDER BY m.created_at DESC LIMIT %s"""
            
            cursor.execute(sql, (group_id, limit))
            messages = cursor.fetchall()

            for message in messages:
                if message['created_at']:
                    message['created_at'] = message['created_at'].strftime('%Y-%m-%dT%H:%M:%S.%fZ')

                if message['media_url'] and not message['media_url'].startswith('/static/'):
                    rel = str(message['media_url'])
                    base = os.path.basename(rel)
                    if 'uploads/files/' in rel:
                        message['media_url'] = f"/static/uploads/files/{base}"
                    else:
                        message['media_url'] = f"/static/uploads/images/{base}"

                if message['parent_media_url'] and not message['parent_media_url'].startswith('/static/'):
                    prel = str(message['parent_media_url'])
                    pbase = os.path.basename(prel)
                    if 'uploads/files/' in prel:
                        message['parent_media_url'] = f"/static/uploads/files/{pbase}"
                    else:
                        message['parent_media_url'] = f"/static/uploads/images/{pbase}"

                # Derive filename from path if missing
                if (not message.get('filename')) and message.get('media_url'):
                    path_base = os.path.basename(str(message['media_url']))
                    message['filename'] = path_base

                # ✅ Clean parent content for forwarded messages (remove sender name)
                if message['message_type'] == 'forward':
                    parent_sender_name = message.get('parent_sender_name', '')
                    parent_content = message.get('parent_content', '')
                    if parent_sender_name and parent_content:
                        cleaned_content = parent_content.replace(parent_sender_name, '', 1).strip()
                        message['content'] = cleaned_content

            return messages

    def mark_message_seen(self, message_id, user_id):
        with self.chat_conn.cursor() as cursor:
            cursor.execute("""
                INSERT INTO message_seen (message_id, user_id) VALUES (%s, %s)
                ON DUPLICATE KEY UPDATE seen_at = CURRENT_TIMESTAMP
            """, (message_id, user_id))
            self.chat_conn.commit()

    def get_message_seen_users(self, message_id):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            sql = """
                SELECT s.user_id, e.name, 
                    CONVERT_TZ(s.seen_at, @@session.time_zone, '+00:00') as seen_at_utc
                FROM message_seen s
                LEFT JOIN ot_employees e ON s.user_id = e.employee_id
                WHERE s.message_id = %s
            """
            cursor.execute(sql, (message_id,))
            users = cursor.fetchall()
            for user in users:
                if user.get('seen_at_utc'):
                    # Return as ISO format string for proper frontend handling
                    user['seen_at'] = user['seen_at_utc'].isoformat() + 'Z' if user['seen_at_utc'] else None
            return users

    def pin_message(self, message_id, pin=True):
        with self.chat_conn.cursor() as cursor:
            sql = "UPDATE messages SET pinned = %s WHERE id = %s"
            cursor.execute(sql, (pin, message_id))
            self.chat_conn.commit()

    def get_pinned_messages(self, sender_id=None, receiver_id=None, group_id=None):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            if group_id:
                sql = "SELECT * FROM messages WHERE group_id = %s AND pinned = TRUE ORDER BY created_at DESC"
                cursor.execute(sql, (group_id,))
            elif sender_id and receiver_id:
                sql = "SELECT * FROM messages WHERE ((sender_id = %s AND receiver_id = %s) OR (sender_id = %s AND receiver_id = %s)) AND group_id IS NULL AND pinned = TRUE ORDER BY created_at DESC"
                cursor.execute(sql, (sender_id, receiver_id, receiver_id, sender_id))
            else:
                return []
            return cursor.fetchall()

    def search_messages(self, query, sender_id=None, receiver_id=None, group_id=None, limit=50):
        with self.chat_conn.cursor(pymysql.cursors.DictCursor) as cursor:
            like_query = f"%{query}%"
            # Search in content OR filename OR media_url (covers images/files by name)
            if group_id:
                sql = (
                    "SELECT * FROM messages "
                    "WHERE group_id = %s AND (content LIKE %s OR filename LIKE %s OR media_url LIKE %s) "
                    "ORDER BY created_at DESC LIMIT %s"
                )
                cursor.execute(sql, (group_id, like_query, like_query, like_query, limit))
            elif sender_id and receiver_id:
                sql = (
                    "SELECT * FROM messages "
                    "WHERE ((sender_id = %s AND receiver_id = %s) OR (sender_id = %s AND receiver_id = %s)) "
                    "AND group_id IS NULL "
                    "AND (content LIKE %s OR filename LIKE %s OR media_url LIKE %s) "
                    "ORDER BY created_at DESC LIMIT %s"
                )
                cursor.execute(sql, (sender_id, receiver_id, receiver_id, sender_id, like_query, like_query, like_query, limit))
            else:
                return []
            return cursor.fetchall()

    def bulk_update_message_status(self, message_ids, is_read=True):
        with self.chat_conn.cursor() as cursor:
            sql = "UPDATE messages SET is_read = %s WHERE id IN (%s)" % (
                is_read, ','.join(['%s'] * len(message_ids)))
            cursor.execute(sql, message_ids)
            self.chat_conn.commit()        

    def __del__(self):
        # Connections are pooled; nothing to close here.
        pass


class _PooledCursorContext:
    def __init__(self, pool, cfg, cursor_class=None):
        self._pool = pool
        self._cfg = cfg
        self._cursor_class = cursor_class
        self._conn = None
        self._cursor = None

    def __enter__(self):
        if self._pool is not None:
            self._conn = self._pool.connection()
        else:
            # Fallback: open a one-off connection
            self._conn = pymysql.connect(**self._cfg)
        self._cursor = self._conn.cursor(self._cursor_class) if self._cursor_class else self._conn.cursor()
        return self._cursor

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                try:
                    self._conn.commit()
                except Exception:
                    pass
            else:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
        finally:
            try:
                if self._cursor is not None:
                    self._cursor.close()
            finally:
                if self._conn is not None:
                    self._conn.close()  # return to pool or close


class _PooledConnectionProxy:
    """
    Lightweight proxy exposing a cursor() context-manager method and commit().
    This keeps existing call-sites intact: `with self.chat_conn.cursor(...) as cur:`
    """

    def __init__(self, pool, cfg):
        self._pool = pool
        self._cfg = cfg

    def cursor(self, cursor_class=None):
        return _PooledCursorContext(self._pool, self._cfg, cursor_class)

    def commit(self):
        # No-op; commits are handled in the context manager
        pass

    def close(self):
        # No-op for proxy
        pass