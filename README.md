Flask Chat Application - Full Setup &
Documentation
1. Overview
This document explains how to install, configure, and run the Flask-based Chat Application built
using Flask, Flask-SocketIO, MySQL, and Pillow.
2. Prerequisites
- Windows, macOS, or Linux
- Python 3.8+
- MySQL Server 5.7 or 8.0
- pip package manager
3. Install Python
Download from https://www.python.org/downloads/
Ensure "Add Python to PATH" is checked.
4. Install MySQL
Download from https://dev.mysql.com/downloads/
Create database:
CREATE DATABASE chatapp_db;
5. Project Setup
Clone repository:
git clone your-repository-url
cd your-project-folder
Install packages:
pip install -r requirements.txt
If missing:
pip install flask flask-socketio eventlet pymysql pillow emoji python-dotenv
6. Database Configuration
Update database.py:
HOST = "localhost"
USER = "root"
PASSWORD = "your-password"
DATABASE = "chatapp_db"
7. Modules Used
- os, re, uuid, base64, imghdr
- emoji, secrets, datetime
- flask, flask_socketio
- pymysql
- PIL (Pillow)
- werkzeug
8. Running Application
python app.py
Open:
http://127.0.0.1:5000
9. Directory Structure
project/
app.py
database.py
static/
templates/
uploads/
requirements.txt
README.md
10. Troubleshooting
MySQL errors → check credentials
SocketIO errors → install eventlet
Image upload issue → check folder permissions
11. License
Open-source.
12. Author
Documentation generated for Flask Chat Application.
