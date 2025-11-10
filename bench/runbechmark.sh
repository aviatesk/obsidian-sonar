#!/bin/bash
set -e

# Default configuration
DATASET="datasets/processed/miracl_ja_dev_miracl_en_dev_subset"
MODEL="intfloat/multilingual-e5-small"
OUTPUT_DIR=""
BACKENDS="elasticsearch,weaviate"
METHODS="bm25,vector,hybrid"
VECTOR_DIMS="384"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dataset)
            DATASET="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --backends)
            BACKENDS="$2"
            shift 2
            ;;
        --methods)
            METHODS="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --vector-dims)
            VECTOR_DIMS="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --dataset PATH        Dataset directory (default: datasets/processed/miracl_ja_dev_miracl_en_dev_subset)"
            echo "  --model NAME          Model name for embeddings path (default: multilingual-e5-small)"
            echo "  --backends LIST       Comma-separated list: elasticsearch,weaviate (default: both)"
            echo "  --methods LIST        Comma-separated list: bm25,vector,hybrid (default: all)"
            echo "  --output-dir PATH     Output directory for results (default: runs/<dataset-name>/<model-name>)"
            echo "  --vector-dims NUM     Vector dimension (default: 384)"
            echo "  --help                Show this help message"
            echo ""
            echo "Example:"
            echo "  $0 --backends elasticsearch --methods bm25,vector"
            echo "  $0 --output-dir runs/experiment1 --methods hybrid"
            echo "  $0 --model multilingual-e5-small --dataset datasets/processed/scidocs_subset"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Update paths based on dataset
CORPUS="${DATASET}/corpus.jsonl"
QUERIES="${DATASET}/queries.jsonl"
QRELS="${DATASET}/qrels.tsv"

# Extract dataset name from full path for embeddings directory
DATASET_NAME=$(basename "$DATASET")
EMBEDDINGS="embeddings/${DATASET_NAME}/${MODEL}/corpus_embeddings.jsonl"
QUERY_EMBEDDINGS="embeddings/${DATASET_NAME}/${MODEL}/query_embeddings.jsonl"

# Set default output directory if not specified
if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="runs/${DATASET_NAME}/${MODEL}"
fi

# Check if required files exist
if [ ! -f "$CORPUS" ]; then
    echo "Error: Corpus file not found: $CORPUS"
    exit 1
fi

if [ ! -f "$QUERIES" ]; then
    echo "Error: Queries file not found: $QUERIES"
    exit 1
fi

if [ ! -f "$QRELS" ]; then
    echo "Error: Qrels file not found: $QRELS"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "=========================================="
echo "Benchmark Configuration"
echo "=========================================="
echo "Dataset:     $DATASET"
echo "Model:       $MODEL"
echo "Backends:    $BACKENDS"
echo "Methods:     $METHODS"
echo "Output:      $OUTPUT_DIR"
echo "Embeddings:  $EMBEDDINGS"
echo ""

# Start Docker services
echo "=========================================="
echo "Starting Docker services"
echo "=========================================="
docker compose up -d

# Wait for Elasticsearch
if [[ "$BACKENDS" == *"elasticsearch"* ]]; then
    echo "Waiting for Elasticsearch..."
    until curl -s http://localhost:9200 > /dev/null; do
        echo "  Elasticsearch not ready yet, waiting..."
        sleep 2
    done
    echo "  Elasticsearch is ready!"
fi

# Wait for Weaviate
if [[ "$BACKENDS" == *"weaviate"* ]]; then
    echo "Waiting for Weaviate..."
    until curl -s http://localhost:8080/v1/.well-known/ready > /dev/null; do
        echo "  Weaviate not ready yet, waiting..."
        sleep 2
    done
    echo "  Weaviate is ready!"
fi

echo ""

# Function to index and search for a backend
run_backend() {
    local backend=$1
    echo "=========================================="
    echo "Backend: $backend"
    echo "=========================================="

    # Determine which methods to run based on available files and configuration
    local has_embeddings=false
    if [ -f "$EMBEDDINGS" ] && [ -f "$QUERY_EMBEDDINGS" ]; then
        has_embeddings=true
    fi

    # Check for skipped methods and display warning
    local skipped_methods=()
    if ! $has_embeddings; then
        if [[ "$METHODS" == *"vector"* ]]; then
            skipped_methods+=("vector")
        fi
        if [[ "$METHODS" == *"hybrid"* ]]; then
            skipped_methods+=("hybrid")
        fi
    fi

    if [ ${#skipped_methods[@]} -gt 0 ]; then
        echo "⚠️  Skipping methods (embeddings not found): ${skipped_methods[*]}"
        echo "   Missing files:"
        echo "     - $EMBEDDINGS"
        echo "     - $QUERY_EMBEDDINGS"
        echo ""
    fi

    # Index
    if [[ "$METHODS" == *"bm25"* ]] && ! $has_embeddings; then
        echo "Step 2a: Indexing corpus (BM25 only) into $backend..."
        uv run scripts/index.py \
            --backend "$backend" \
            --dataset "$DATASET"
        echo ""
    fi

    if $has_embeddings && [[ "$METHODS" == *"vector"* || "$METHODS" == *"hybrid"* ]]; then
        echo "Step 2b: Indexing chunks with embeddings into $backend..."
        uv run scripts/index.py \
            --backend "$backend" \
            --embeddings "$EMBEDDINGS" \
            --vector-dims "$VECTOR_DIMS"
        echo ""
    fi

    # Search
    if [[ "$METHODS" == *"bm25"* ]]; then
        echo "Step 3a: Searching with BM25..."
        uv run scripts/search.py \
            --backend "$backend" \
            --queries "$QUERIES" \
            --output "$OUTPUT_DIR/${backend}.bm25.trec" \
            --method bm25
        echo ""
    fi

    if $has_embeddings && [[ "$METHODS" == *"vector"* ]]; then
        echo "Step 3b: Searching with Vector..."
        uv run scripts/search.py \
            --backend "$backend" \
            --queries "$QUERIES" \
            --output "$OUTPUT_DIR/${backend}.vector.trec" \
            --method vector \
            --embeddings "$QUERY_EMBEDDINGS"
        echo ""
    fi

    if $has_embeddings && [[ "$METHODS" == *"hybrid"* ]]; then
        echo "Step 3c: Searching with Hybrid (BM25 + Vector)..."
        uv run scripts/search.py \
            --backend "$backend" \
            --queries "$QUERIES" \
            --output "$OUTPUT_DIR/${backend}.hybrid.trec" \
            --method hybrid \
            --embeddings "$QUERY_EMBEDDINGS"
        echo ""
    fi
}

IFS=',' read -ra BACKEND_ARRAY <<< "$BACKENDS"
for backend in "${BACKEND_ARRAY[@]}"; do
    run_backend "$backend"
done

echo "=========================================="
echo "Evaluating results"
echo "=========================================="
uv run scripts/evaluate.py \
    --runs "$OUTPUT_DIR"/*.trec \
    --qrels "$QRELS"

echo ""
echo "=========================================="
echo "Benchmark complete!"
echo "=========================================="
echo "Results saved in: $OUTPUT_DIR/"
