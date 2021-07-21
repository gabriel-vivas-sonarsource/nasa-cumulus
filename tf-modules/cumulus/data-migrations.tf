module "data_migration2" {
  source = "../../lambdas/data-migration2"

  prefix = var.prefix

  permissions_boundary_arn = var.permissions_boundary_arn

  vpc_id            = var.vpc_id
  lambda_subnet_ids = var.lambda_subnet_ids

  dynamo_tables = var.dynamo_tables

  rds_security_group_id      = var.rds_security_group
  rds_user_access_secret_arn = var.rds_user_access_secret_arn
  rds_connection_heartbeat   = var.rds_connection_heartbeat
  db_retry_failed_connection = var.db_retry_failed_connection
  db_retry_configuration     = var.db_retry_configuration

  system_bucket = var.system_bucket

  tags = var.tags
}
