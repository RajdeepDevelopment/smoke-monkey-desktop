terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "rag-platform-terraform-state"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "rag-platform-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = "rag-platform"
}

# ── Networking ───────────────────────────────────────────────────────────────
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name_prefix}-private-${count.index}" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 2)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name_prefix}-public-${count.index}" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── EKS cluster ──────────────────────────────────────────────────────────────
resource "aws_iam_role" "eks" {
  name = "${local.name_prefix}-eks-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_policy" {
  role       = aws_iam_role.eks.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "main" {
  name     = local.name_prefix
  role_arn = aws_iam_role.eks.arn
  vpc_config {
    subnet_ids = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
  }
  depends_on = [aws_iam_role_policy_attachment.eks_policy]
}

resource "aws_iam_role" "nodes" {
  name = "${local.name_prefix}-nodes"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "nodes_eks" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}
resource "aws_iam_role_policy_attachment" "nodes_cni" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}
resource "aws_iam_role_policy_attachment" "nodes_registry" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "general"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = ["m5.large"]

  scaling_config {
    desired_size = 2
    min_size     = 2
    max_size     = 6
  }
}

# GPU nodes for a self-hosted LLM (vLLM/Ollama) — optional
resource "aws_eks_node_group" "gpu" {
  count           = var.enable_gpu_nodes ? 1 : 0
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "gpu"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = ["g4dn.xlarge"]

  scaling_config {
    desired_size = 1
    min_size     = 1
    max_size     = 2
  }
}

# ── RDS Postgres + pgvector ──────────────────────────────────────────────────
resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name_prefix = "${local.name_prefix}-db"
  vpc_id      = aws_vpc.main.id
}

resource "aws_db_instance" "postgres" {
  identifier             = "${local.name_prefix}-pg"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = var.db_instance_class
  allocated_storage      = 100
  storage_type           = "gp3"
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.pgvector.name
  skip_final_snapshot    = true
}

resource "aws_db_parameter_group" "pgvector" {
  name   = "${local.name_prefix}-pgvector"
  family = "postgres16"

  parameter {
    name  = "shared_preload_libraries"
    value = "vector"
  }
}

# ── ElastiCache Redis ────────────────────────────────────────────────────────
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${local.name_prefix}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.small"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.db.id]
}

# ── S3 (replaces MinIO in production) ────────────────────────────────────────
resource "aws_s3_bucket" "documents" {
  bucket = "${local.name_prefix}-documents"
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── ECR repositories ─────────────────────────────────────────────────────────
resource "aws_ecr_repository" "images" {
  for_each = toset(["api-gateway", "rag-service", "document-worker", "web"])
  name     = "${local.name_prefix}/${each.key}"
  image_scanning_configuration {
    scan_on_push = true
  }
}
