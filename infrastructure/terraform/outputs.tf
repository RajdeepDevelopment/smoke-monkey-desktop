output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "postgres_endpoint" {
  description = "RDS Postgres endpoint"
  value       = aws_db_instance.postgres.address
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "documents_bucket" {
  description = "S3 bucket for original PDFs"
  value       = aws_s3_bucket.documents.id
}

output "ecr_repos" {
  description = "ECR repository URIs"
  value       = { for k, r in aws_ecr_repository.images : k => r.repository_url }
}
