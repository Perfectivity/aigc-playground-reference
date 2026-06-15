# Gunicorn Configuration for VOD AIGC Chat
# Usage: gunicorn -c gunicorn.conf.py app:app

# Server socket
bind = "0.0.0.0:5050"

# Worker processes (fixed count – avoids spawning too many on large machines)
workers = 3
worker_class = "gthread"     # thread-based (good for I/O-bound like API proxy)
threads = 4
timeout = 1200               # AIGC API can be very slow (image2_high can exceed 10min)
graceful_timeout = 30

# Logging
accesslog = "/var/log/aigc-chat/access.log"
errorlog = "/var/log/aigc-chat/error.log"
loglevel = "info"

# Process naming
proc_name = "aigc-chat"

# Security
limit_request_line = 8190
limit_request_fields = 100
