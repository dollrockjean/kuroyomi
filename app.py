import os
import server

if __name__ == "__main__":
    # Port 7860 is required for Hugging Face Spaces; defaults to 8000 on Render/local
    port = int(os.environ.get("PORT", 7860))
    server.run(port=port, host="0.0.0.0")
