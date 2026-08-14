"""
Dienstrooster Solver Service (Phase 0 Placeholder)

Phase 0 only includes health check endpoint.
Full solver implementation comes in Phase 2.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Dienstrooster Solver",
    description="Shift scheduling solver using CP-SAT",
    version="0.1.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins in development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint for Docker"""
    return {"status": "ok", "service": "solver"}


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Dienstrooster Solver",
        "version": "0.1.0",
        "status": "Phase 0 - Placeholder",
        "message": "Full solver implementation in Phase 2"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
