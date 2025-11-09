#!/bin/bash
set -e

# Default configuration
DATASETS="miracl,scidocs"
MODEL="intfloat/multilingual-e5-small"
MODEL_NAME="multilingual-e5-small"
MIRACL_QUERIES=200
SCIDOCS_QUERIES=100
BATCH_SIZE=128
SKIP_SUBSET=false
SKIP_EMBEDDINGS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --datasets)
            DATASETS="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --model-name)
            MODEL_NAME="$2"
            shift 2
            ;;
        --miracl-queries)
            MIRACL_QUERIES="$2"
            shift 2
            ;;
        --scidocs-queries)
            SCIDOCS_QUERIES="$2"
            shift 2
            ;;
        --batch-size)
            BATCH_SIZE="$2"
            shift 2
            ;;
        --skip-subset)
            SKIP_SUBSET=true
            shift
            ;;
        --skip-embeddings)
            SKIP_EMBEDDINGS=true
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Generate benchmark subsets and embeddings for Sonar evaluation."
            echo ""
            echo "Options:"
            echo "  --datasets LIST           Comma-separated list: miracl,scidocs (default: both)"
            echo "  --model MODEL_ID          HuggingFace model ID (default: intfloat/multilingual-e5-small)"
            echo "  --model-name NAME         Short model name for paths (default: multilingual-e5-small)"
            echo "  --miracl-queries N        Number of MIRACL queries (default: 200)"
            echo "  --scidocs-queries N       Number of SCIDOCS queries (default: 100)"
            echo "  --batch-size N            Embedding batch size (default: 128)"
            echo "  --skip-subset             Skip subset generation (Step 3)"
            echo "  --skip-embeddings         Skip embeddings generation (Step 4)"
            echo "  --help                    Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0"
            echo "  $0 --datasets miracl --miracl-queries 100"
            echo "  $0 --model intfloat/multilingual-e5-small --model-name multilingual-e5-small"
            echo "  $0 --skip-subset  # Only generate embeddings"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

echo "=========================================="
echo "Benchmark Data Generation"
echo "=========================================="
echo "Datasets:          $DATASETS"
echo "Model:             $MODEL"
echo "Model name:        $MODEL_NAME"
echo "MIRACL queries:    $MIRACL_QUERIES"
echo "SCIDOCS queries:   $SCIDOCS_QUERIES"
echo "Batch size:        $BATCH_SIZE"
echo "Skip subset:       $SKIP_SUBSET"
echo "Skip embeddings:   $SKIP_EMBEDDINGS"
echo ""

# Step 3: Generate benchmark subsets
if ! $SKIP_SUBSET; then
    echo "=========================================="
    echo "Step 3: Generate benchmark subsets"
    echo "=========================================="

    if [[ "$DATASETS" == *"miracl"* ]]; then
        echo ""
        echo "Generating MIRACL subset (${MIRACL_QUERIES} queries, 1:1 ja:en ratio)..."
        uv run scripts/generate_subset.py \
            --corpus datasets/raw/miracl_ja_corpus_dev.jsonl,datasets/raw/miracl_en_corpus_dev.jsonl \
            --queries datasets/raw/miracl_ja_queries_dev.jsonl,datasets/raw/miracl_en_queries_dev.jsonl \
            --qrels datasets/raw/miracl_ja_qrels_dev.tsv,datasets/raw/miracl_en_qrels_dev.tsv \
            --n-queries "$MIRACL_QUERIES"
        echo "✓ MIRACL subset generated"
    fi

    if [[ "$DATASETS" == *"scidocs"* ]]; then
        echo ""
        echo "Generating SCIDOCS subset (${SCIDOCS_QUERIES} queries)..."
        uv run scripts/generate_subset.py \
            --corpus datasets/raw/scidocs_corpus.jsonl \
            --queries datasets/raw/scidocs_queries.jsonl \
            --qrels datasets/raw/scidocs_qrels.tsv \
            --n-queries "$SCIDOCS_QUERIES"
        echo "✓ SCIDOCS subset generated"
    fi

    echo ""
    echo "Step 3 complete!"
else
    echo "Skipping Step 3 (subset generation)"
fi

# Step 4: Generate embeddings
if ! $SKIP_EMBEDDINGS; then
    echo ""
    echo "=========================================="
    echo "Step 4: Generate embeddings"
    echo "=========================================="

    if [[ "$DATASETS" == *"miracl"* ]]; then
        MIRACL_DATASET="datasets/processed/miracl_ja_dev_miracl_en_dev_subset"
        MIRACL_EMBEDDINGS_DIR="embeddings/miracl_ja_dev_miracl_en_dev_subset/${MODEL_NAME}"

        echo ""
        echo "Generating MIRACL embeddings..."

        # Corpus embeddings
        echo "  Generating corpus embeddings..."
        uv run scripts/generate_embeddings.py \
            --corpus "${MIRACL_DATASET}/corpus.jsonl" \
            --output "${MIRACL_EMBEDDINGS_DIR}/corpus_embeddings.jsonl" \
            --model "$MODEL" \
            --batch-size "$BATCH_SIZE"

        # Query embeddings
        echo "  Generating query embeddings..."
        uv run scripts/generate_embeddings.py \
            --corpus "${MIRACL_DATASET}/queries.jsonl" \
            --output "${MIRACL_EMBEDDINGS_DIR}/query_embeddings.jsonl" \
            --model "$MODEL" \
            --batch-size "$BATCH_SIZE"

        echo "✓ MIRACL embeddings generated"
    fi

    if [[ "$DATASETS" == *"scidocs"* ]]; then
        SCIDOCS_DATASET="datasets/processed/scidocs_subset"
        SCIDOCS_EMBEDDINGS_DIR="embeddings/scidocs_subset/${MODEL_NAME}"

        echo ""
        echo "Generating SCIDOCS embeddings..."

        # Corpus embeddings
        echo "  Generating corpus embeddings..."
        uv run scripts/generate_embeddings.py \
            --corpus "${SCIDOCS_DATASET}/corpus.jsonl" \
            --output "${SCIDOCS_EMBEDDINGS_DIR}/corpus_embeddings.jsonl" \
            --model "$MODEL" \
            --batch-size "$BATCH_SIZE"

        # Query embeddings
        echo "  Generating query embeddings..."
        uv run scripts/generate_embeddings.py \
            --corpus "${SCIDOCS_DATASET}/queries.jsonl" \
            --output "${SCIDOCS_EMBEDDINGS_DIR}/query_embeddings.jsonl" \
            --model "$MODEL" \
            --batch-size "$BATCH_SIZE"

        echo "✓ SCIDOCS embeddings generated"
    fi

    echo ""
    echo "Step 4 complete!"
else
    echo "Skipping Step 4 (embeddings generation)"
fi

echo ""
echo "=========================================="
echo "Generation Complete!"
echo "=========================================="
echo ""

if ! $SKIP_SUBSET; then
    echo "Generated subsets:"
    if [[ "$DATASETS" == *"miracl"* ]]; then
        echo "  - datasets/processed/miracl_ja_dev_miracl_en_dev_subset/"
    fi
    if [[ "$DATASETS" == *"scidocs"* ]]; then
        echo "  - datasets/processed/scidocs_subset/"
    fi
    echo ""
fi

if ! $SKIP_EMBEDDINGS; then
    echo "Generated embeddings:"
    if [[ "$DATASETS" == *"miracl"* ]]; then
        echo "  - embeddings/miracl_ja_dev_miracl_en_dev_subset/${MODEL_NAME}/"
    fi
    if [[ "$DATASETS" == *"scidocs"* ]]; then
        echo "  - embeddings/scidocs_subset/${MODEL_NAME}/"
    fi
    echo ""
fi

echo "Next steps:"
echo "  - For Sonar benchmarks: Run Step 3.5 (generate vaults)"
echo "  - For ES/Weaviate: Run ./run_benchmark.sh"
