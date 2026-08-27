variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "enable_gpu_nodes" {
  description = "Provision a GPU node group for self-hosted LLMs"
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.large"
}

variable "db_username" {
  description = "RDS master username"
  type        = string
  default     = "rag"
}

variable "db_password" {
  description = "RDS master password (set via TF_VAR_db_password or secrets)"
  type        = string
  sensitive   = true
}
