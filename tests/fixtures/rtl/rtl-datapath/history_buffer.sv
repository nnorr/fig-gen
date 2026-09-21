module history_buffer #(
  parameter int ADDR_W = 4,
  parameter int DATA_W = 8
) (
  input  logic              clk,
  input  logic              wr_en,
  input  logic [ADDR_W-1:0] wr_addr,
  input  logic [DATA_W-1:0] wr_data,
  input  logic [ADDR_W-1:0] rd_addr,
  output logic [DATA_W-1:0] rd_data
);
  logic [DATA_W-1:0] mem [0:(1<<ADDR_W)-1];

  always_ff @(posedge clk) begin
    if (wr_en) mem[wr_addr] <= wr_data;
  end

  assign rd_data = mem[rd_addr];
endmodule
